import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';
import {
  decodeHtmlEntities,
  extractTextBody,
  getHeader,
  listAttachmentNames,
  stripQuotedReply,
  truncateBody,
  type GmailMessagePart,
} from '../utils/mime.js';
import { getAccessToken } from '../utils/tool-config.js';

const GMAIL_API_BASE_URL = 'https://www.googleapis.com/gmail/v1';

// The API's own default page size is 100, far more than a chat reply can use;
// 20 keeps a search readable and 50 is the most the tool will ever request.
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 50;

// messages.list returns stubs only, so every result needs its own metadata get;
// five in flight keeps a 50-result search quick without risking rate limits.
const METADATA_FETCH_CONCURRENCY = 5;

// Bounds one batchModify body and one approval card payload.
const MAX_BULK_MESSAGE_IDS = 50;

// Nothing downstream truncates tool output, so this cap is the only guard
// against a newsletter filling the model's context window. 8,000 holds a
// whole receipt or booking; anything longer keeps its head and tail.
const MAX_MESSAGE_BODY_CHARS = 8000;

// A thread is replayed on every turn of the sitting, so 25 messages of 1,500
// characters (~40 KB) is the ceiling one catch-up call may add to the context.
// The cap applies after quoted history is stripped, so it bounds new text.
const MAX_THREAD_MESSAGE_BODY_CHARS = 1500;
const MAX_THREAD_MESSAGES = 25;

const NO_READABLE_BODY = '(no readable body)';

// Gmail IDs are hex; "." and ".." would otherwise normalise to a different
// endpoint after encodeURIComponent.
const GMAIL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type GmailLabel = {
  id: string;
  name?: string;
  type?: 'system' | 'user';
};

type ListLabelsResponse = {
  labels?: GmailLabel[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
};

type GmailThread = {
  messages?: GmailMessage[];
};

type ListMessagesResponse = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

function buildLabelsUrl(): string {
  return new URL(`${GMAIL_API_BASE_URL}/users/me/labels`).toString();
}

function buildSearchMessagesUrl(input: {
  query: string;
  maxResults?: number;
  includeSpamTrash?: boolean;
}): string {
  const url = new URL(`${GMAIL_API_BASE_URL}/users/me/messages`);

  url.searchParams.set('q', input.query);
  url.searchParams.set(
    'maxResults',
    String(input.maxResults ?? DEFAULT_SEARCH_RESULTS),
  );

  if (input.includeSpamTrash) {
    url.searchParams.set('includeSpamTrash', 'true');
  }

  return url.toString();
}

function buildMessageMetadataUrl(messageId: string): string {
  const url = new URL(
    `${GMAIL_API_BASE_URL}/users/me/messages/${encodeURIComponent(messageId)}`,
  );

  url.searchParams.set('format', 'metadata');

  // metadataHeaders is a repeated query parameter, not comma-joined.
  for (const header of ['From', 'Subject', 'Date']) {
    url.searchParams.append('metadataHeaders', header);
  }

  return url.toString();
}

function buildMessageUrl(messageId: string): string {
  const url = new URL(
    `${GMAIL_API_BASE_URL}/users/me/messages/${encodeURIComponent(messageId)}`,
  );

  url.searchParams.set('format', 'full');

  return url.toString();
}

function buildThreadUrl(threadId: string): string {
  const url = new URL(
    `${GMAIL_API_BASE_URL}/users/me/threads/${encodeURIComponent(threadId)}`,
  );

  url.searchParams.set('format', 'full');

  return url.toString();
}

// Writes each result by index so the output order matches the input order
// regardless of which request finishes first. Once one call fails the other
// workers stop taking new items, since the whole result is discarded.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;

        if (failed || index >= items.length) {
          return;
        }

        try {
          results[index] = await fn(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );

  await Promise.all(workers);

  return results;
}

// A message can disappear between the call that produced its ID and this
// fetch, so a 404 drops it from the result and is reported as a count.
async function fetchMessageMetadata(
  ids: string[],
  accessToken: string,
): Promise<{ messages: GmailMessage[]; droppedCount: number }> {
  const fetched = await mapWithConcurrency(
    ids,
    METADATA_FETCH_CONCURRENCY,
    async (id) => {
      try {
        return await fetchWithAuth<GmailMessage>(
          buildMessageMetadataUrl(id),
          {
            method: 'GET',
          },
          accessToken,
        );
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) {
          return null;
        }

        throw error;
      }
    },
  );

  const messages = fetched.filter(
    (message): message is GmailMessage => message !== null,
  );

  return { messages, droppedCount: fetched.length - messages.length };
}

function isUnread(labelIds: string[] | undefined): boolean {
  return labelIds?.includes('UNREAD') ?? false;
}

// TRASH and SPAM both drop INBOX, so reporting either as "archived" would
// mislead the agent about where the message actually sits.
function formatStatus(labelIds: string[] | undefined): string {
  const location = labelIds?.includes('TRASH')
    ? 'in trash'
    : labelIds?.includes('SPAM')
      ? 'in spam'
      : labelIds?.includes('INBOX')
        ? 'in inbox'
        : 'archived';

  return `${isUnread(labelIds) ? 'unread' : 'read'}, ${location}`;
}

// Collapsed to one line so an untrusted header value cannot break the line
// format that the agent reads.
function headerText(payload: GmailMessagePart | undefined, name: string) {
  return getHeader(payload, name)?.replace(/\s+/g, ' ').trim();
}

function describeMessage(message: GmailMessage): {
  date: string;
  from: string;
  subject: string;
} {
  return {
    date: headerText(message.payload, 'Date') || '(no date)',
    from: headerText(message.payload, 'From') || '(unknown sender)',
    subject: headerText(message.payload, 'Subject') || '(no subject)',
  };
}

function formatLabels(labels: GmailLabel[]): string {
  if (labels.length === 0) {
    return 'No labels found.';
  }

  // The API returns labels in an arbitrary order; system labels first then
  // user labels by name keeps the output stable across calls.
  const rows = labels.map((label) => ({
    id: label.id,
    name: label.name?.trim() || 'Untitled label',
    type: label.type ?? 'user',
  }));

  rows.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'system' ? -1 : 1;
    }

    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });

  const lines = rows.map(
    (row) => `- ${row.name} (${row.type}) (id: ${row.id})`,
  );

  return `Labels:\n${lines.join('\n')}`;
}

export const listGmailLabels = tool(
  async (_input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListLabelsResponse>(
      buildLabelsUrl(),
      {
        method: 'GET',
      },
      accessToken,
    );

    return formatLabels(response?.labels ?? []);
  },
  {
    name: 'list_gmail_labels',
    description:
      "List the labels in the user's Gmail account. Use this to resolve a label name to the ID that the other Gmail tools require.",
    schema: z.object({}),
  },
);

function formatSearchResults(messages: GmailMessage[]): string {
  if (messages.length === 0) {
    return 'No messages match that search.';
  }

  const lines = messages.map((message) => {
    const { date, from, subject } = describeMessage(message);
    const unread = isUnread(message.labelIds) ? ' [unread]' : '';
    const snippet = decodeHtmlEntities(message.snippet ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return `- ${date} — ${from} — ${subject}${unread}${snippet ? `: ${snippet}` : ''} (id: ${message.id}, thread id: ${message.threadId ?? 'unknown'})`;
  });

  return `Messages:\n${lines.join('\n')}`;
}

const searchGmailSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Gmail search query, e.g. "from:amazon", "newer_than:7d", "is:unread", "category:promotions"; combine terms with spaces. Must not be empty: for "anything new?" use newer_than:1d or newer_than:7d.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe('Maximum number of messages to return, 1 to 50. Defaults to 20.'),
  includeSpamTrash: z
    .boolean()
    .optional()
    .describe('Include messages in Spam and Trash. Defaults to false.'),
});

export const searchGmail = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListMessagesResponse>(
      buildSearchMessagesUrl(input),
      {
        method: 'GET',
      },
      accessToken,
    );

    const stubs = response?.messages ?? [];
    const { messages } = await fetchMessageMetadata(
      stubs.map((stub) => stub.id),
      accessToken,
    );
    const formatted = formatSearchResults(messages);

    if (response?.nextPageToken && messages.length > 0) {
      const estimate = response.resultSizeEstimate;
      const scope =
        typeof estimate === 'number' && estimate > 0
          ? `${messages.length} of about ${estimate}`
          : `${messages.length}`;

      return `${formatted}\n\nNote: only the first ${scope} matching messages are shown. Tell the user the list is incomplete and suggest narrowing the query.`;
    }

    return formatted;
  },
  {
    name: 'search_gmail',
    description:
      "Search the user's Gmail with Gmail query syntax. Returns one line per matching message with date, sender, subject, an unread marker, a snippet, and the message and thread IDs that get_gmail_message and get_gmail_thread require.",
    schema: searchGmailSchema,
  },
);

function formatMessageDetail(message: GmailMessage): string {
  const { date, from, subject } = describeMessage(message);
  const lines = [`From: ${from}`];
  const to = headerText(message.payload, 'To');
  const cc = headerText(message.payload, 'Cc');

  if (to) {
    lines.push(`To: ${to}`);
  }

  if (cc) {
    lines.push(`Cc: ${cc}`);
  }

  lines.push(`Date: ${date}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Status: ${formatStatus(message.labelIds)}`);

  const attachments = listAttachmentNames(message.payload);

  if (attachments.length > 0) {
    lines.push(`Attachments: ${attachments.join(', ')}`);
  }

  if (message.threadId) {
    lines.push(`Thread id: ${message.threadId}`);
  }

  lines.push('');
  lines.push(
    truncateBody(extractTextBody(message.payload), MAX_MESSAGE_BODY_CHARS) ||
      NO_READABLE_BODY,
  );

  return lines.join('\n');
}

export const getGmailMessage = tool(
  async ({ messageId }, config) => {
    const accessToken = getAccessToken(config);
    const notFoundMessage =
      'No message found with that ID. It may have been deleted.';

    try {
      const message = await fetchWithAuth<GmailMessage>(
        buildMessageUrl(messageId),
        {
          method: 'GET',
        },
        accessToken,
      );

      if (!message) {
        return notFoundMessage;
      }

      return formatMessageDetail(message);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return notFoundMessage;
      }

      throw error;
    }
  },
  {
    name: 'get_gmail_message',
    description:
      'Get the full content of a single Gmail message, including its headers, attachment names, and body text (a long body keeps its start and end, with a note on how much was omitted). The output includes the thread ID for get_gmail_thread.',
    schema: z.object({
      messageId: z
        .string()
        .trim()
        .regex(GMAIL_ID_PATTERN)
        .describe(
          'The message ID, obtained from search_gmail or get_gmail_thread.',
        ),
    }),
  },
);

function formatThread(messages: GmailMessage[]): string {
  const subject = describeMessage(messages[0]!).subject;
  // The API already returns messages in conversation order, so keep it and
  // show the tail, which is what catching up on a long thread needs.
  const shown = messages.slice(-MAX_THREAD_MESSAGES);
  const lines = [`Thread: ${subject} (${messages.length} messages)`];

  if (messages.length > MAX_THREAD_MESSAGES) {
    lines.push(
      `Note: this thread has ${messages.length} messages; only the most recent ${MAX_THREAD_MESSAGES} are shown.`,
    );
  }

  for (const message of shown) {
    const { date, from } = describeMessage(message);
    const body =
      truncateBody(
        stripQuotedReply(extractTextBody(message.payload)),
        MAX_THREAD_MESSAGE_BODY_CHARS,
      ) || NO_READABLE_BODY;

    lines.push('');
    lines.push(`--- ${date} — ${from} (id: ${message.id})`);
    // Indented so an email body cannot forge the header line above.
    lines.push(body.replace(/^/gm, '  '));
  }

  return lines.join('\n');
}

export const getGmailThread = tool(
  async ({ threadId }, config) => {
    const accessToken = getAccessToken(config);
    const notFoundMessage =
      'No thread found with that ID. It may have been deleted.';

    try {
      // threads.get?format=full returns every message body in one response, so
      // it needs a longer timeout than the 10 second default.
      const thread = await fetchWithAuth<GmailThread>(
        buildThreadUrl(threadId),
        {
          method: 'GET',
        },
        accessToken,
        { timeoutMs: 20_000 },
      );

      const messages = thread?.messages ?? [];

      if (messages.length === 0) {
        return notFoundMessage;
      }

      return formatThread(messages);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return notFoundMessage;
      }

      throw error;
    }
  },
  {
    name: 'get_gmail_thread',
    description:
      'Get every message in a Gmail thread in order, each with its date, sender, message ID, and body text (quoted replies removed, then truncated per message). Use this to catch up on a conversation found with search_gmail.',
    schema: z.object({
      threadId: z
        .string()
        .trim()
        .regex(GMAIL_ID_PATTERN)
        .describe(
          'The thread ID, obtained from search_gmail or get_gmail_message.',
        ),
    }),
  },
);

// Trash and spam are destructive, star is unsupported, and Gmail refuses to
// apply SENT or DRAFT by hand, so all are rejected before any card is shown.
const UNSUPPORTED_LABEL_IDS = ['SPAM', 'STARRED', 'TRASH', 'SENT', 'DRAFT'];
const UNSUPPORTED_LABEL_MESSAGE =
  'SPAM, STARRED, TRASH, SENT, and DRAFT cannot be changed with this tool. Use trash_gmail_messages to move messages to Trash.';

const labelIdListSchema = z.array(z.string().trim().min(1));

const modifyGmailLabelsSchema = z
  .object({
    messageIds: z
      .array(z.string().trim().regex(GMAIL_ID_PATTERN))
      .min(1)
      .max(MAX_BULK_MESSAGE_IDS)
      .describe(
        `The message IDs to change, obtained from search_gmail. 1 to ${MAX_BULK_MESSAGE_IDS} IDs.`,
      ),
    addLabelIds: labelIdListSchema
      .optional()
      .describe(
        'Label IDs to add: the system labels INBOX, UNREAD, or IMPORTANT, or an ID from list_gmail_labels.',
      ),
    removeLabelIds: labelIdListSchema
      .optional()
      .describe(
        'Label IDs to remove: the system labels INBOX, UNREAD, or IMPORTANT, or an ID from list_gmail_labels. Removing INBOX archives the messages.',
      ),
  })
  .superRefine((input, ctx) => {
    const addLabelIds = input.addLabelIds ?? [];
    const removeLabelIds = input.removeLabelIds ?? [];

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one label ID to add or remove.',
      });
    }

    const added = new Set(addLabelIds);
    const inBoth = removeLabelIds.filter((labelId) => added.has(labelId));

    if (inBoth.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Label ID '${inBoth[0]}' cannot be both added and removed.`,
      });
    }

    for (const labelId of [...addLabelIds, ...removeLabelIds]) {
      if (UNSUPPORTED_LABEL_IDS.includes(labelId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: UNSUPPORTED_LABEL_MESSAGE,
        });
      }
    }
  });

function buildBatchModifyUrl(): string {
  return new URL(
    `${GMAIL_API_BASE_URL}/users/me/messages/batchModify`,
  ).toString();
}

function buildBatchModifyRequestBody(input: {
  ids: string[];
  addLabelIds: string[];
  removeLabelIds: string[];
}): Record<string, string[]> {
  const body: Record<string, string[]> = { ids: input.ids };

  if (input.addLabelIds.length > 0) {
    body.addLabelIds = input.addLabelIds;
  }

  if (input.removeLabelIds.length > 0) {
    body.removeLabelIds = input.removeLabelIds;
  }

  return body;
}

// Read state is reversible and invisible, so it is the one label change that
// skips both the approval card and the metadata fetch behind it.
function isUnreadOnlyChange(
  addLabelIds: string[],
  removeLabelIds: string[],
): boolean {
  return [...addLabelIds, ...removeLabelIds].every(
    (labelId) => labelId === 'UNREAD',
  );
}

type Phrase = (messages: string) => string;

type LabelChange = {
  card: string;
  present: Phrase;
  past: Phrase;
};

// One table for all three tenses so the description, the card, and the
// confirmation cannot drift. Each phrase takes the noun it acts on, so a
// label name can never collide with a placeholder.
function describeLabelChange(
  operation: 'add' | 'remove',
  labelId: string,
  labelName: string,
): LabelChange {
  if (labelId === 'INBOX') {
    return operation === 'remove'
      ? {
          card: 'Archive',
          present: (n) => `Archive ${n}`,
          past: (n) => `Archived ${n}`,
        }
      : {
          card: 'Move to Inbox',
          present: (n) => `Move ${n} to Inbox`,
          past: (n) => `Moved ${n} to Inbox`,
        };
  }

  if (labelId === 'UNREAD') {
    return operation === 'add'
      ? {
          card: 'Mark as unread',
          present: (n) => `Mark ${n} as unread`,
          past: (n) => `Marked ${n} as unread`,
        }
      : {
          card: 'Mark as read',
          present: (n) => `Mark ${n} as read`,
          past: (n) => `Marked ${n} as read`,
        };
  }

  return operation === 'add'
    ? {
        card: `Add label "${labelName}"`,
        present: (n) => `Add label "${labelName}" to ${n}`,
        past: (n) => `Added label "${labelName}" to ${n}`,
      }
    : {
        card: `Remove label "${labelName}"`,
        present: (n) => `Remove label "${labelName}" from ${n}`,
        past: (n) => `Removed label "${labelName}" from ${n}`,
      };
}

function collectLabelChanges(
  addLabelIds: string[],
  removeLabelIds: string[],
  labelNames: Map<string, string> = new Map(),
): LabelChange[] {
  return [
    ...addLabelIds.map((labelId) =>
      describeLabelChange('add', labelId, labelNames.get(labelId) ?? labelId),
    ),
    ...removeLabelIds.map((labelId) =>
      describeLabelChange(
        'remove',
        labelId,
        labelNames.get(labelId) ?? labelId,
      ),
    ),
  ];
}

function formatMessageCount(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

// Sibling of formatMessageCount for clauses that carry a bare count and need
// the rest of the clause to agree with it.
function formatCountClause(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Only the first phrase names the messages; the rest say "them", which reads
// as one sentence instead of repeating the count for every label change.
function joinChangePhrases(
  changes: LabelChange[],
  tense: 'present' | 'past',
  count: number,
): string {
  const sentence = changes
    .map((change, index) => {
      if (index === 0) {
        return change[tense](formatMessageCount(count));
      }

      const later = change[tense]('them');

      return later.charAt(0).toLowerCase() + later.slice(1);
    })
    .join(', ');

  return `${sentence}.`;
}

async function runBatchModify(
  body: {
    ids: string[];
    addLabelIds: string[];
    removeLabelIds: string[];
  },
  accessToken: string,
): Promise<string | null> {
  try {
    // batchModify answers with an empty body, which fetchWithAuth maps to
    // null; that is the success case, not a missing resource.
    await fetchWithAuth(
      buildBatchModifyUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBatchModifyRequestBody(body)),
      },
      accessToken,
    );

    return null;
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      return 'Some of those messages no longer exist, so nothing was changed. Search again and retry.';
    }

    throw error;
  }
}

export const modifyGmailLabels = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    // A repeated ID would otherwise double a card row, a phrase in the
    // description, or an entry in the batch body.
    const messageIds = [...new Set(input.messageIds)];
    const addLabelIds = [...new Set(input.addLabelIds ?? [])];
    const removeLabelIds = [...new Set(input.removeLabelIds ?? [])];

    if (isUnreadOnlyChange(addLabelIds, removeLabelIds)) {
      const changes = collectLabelChanges(addLabelIds, removeLabelIds);
      const failure = await runBatchModify(
        { ids: messageIds, addLabelIds, removeLabelIds },
        accessToken,
      );

      return failure ?? joinChangePhrases(changes, 'past', messageIds.length);
    }

    const labelsResponse = await fetchWithAuth<ListLabelsResponse>(
      buildLabelsUrl(),
      {
        method: 'GET',
      },
      accessToken,
    );
    const labelNames = new Map(
      (labelsResponse?.labels ?? []).map((label) => [
        label.id,
        label.name?.replace(/\s+/g, ' ').trim() || label.id,
      ]),
    );
    // Rejected before the interrupt so an approved write never fails on a
    // label the user already said yes to.
    const unknownLabelIds = [...addLabelIds, ...removeLabelIds].filter(
      (labelId) => !labelNames.has(labelId),
    );

    if (unknownLabelIds.length > 0) {
      const quoted = unknownLabelIds
        .map((labelId) => `'${labelId}'`)
        .join(', ');

      return `No label found with ID ${quoted}. Call list_gmail_labels to find the right ID.`;
    }

    const { messages, droppedCount } = await fetchMessageMetadata(
      messageIds,
      accessToken,
    );

    if (messages.length === 0) {
      return 'None of those messages exist any more. They may have been deleted.';
    }

    const changes = collectLabelChanges(
      addLabelIds,
      removeLabelIds,
      labelNames,
    );
    const decision = interrupt<
      {
        action: 'modify_gmail_labels';
        description: string;
        current: { count: number };
        proposed: { change: string };
        messages: Array<ReturnType<typeof describeMessage>>;
      },
      'approve' | 'reject'
    >({
      action: 'modify_gmail_labels',
      description: joinChangePhrases(changes, 'present', messages.length),
      current: { count: messages.length },
      proposed: { change: changes.map((change) => change.card).join(', ') },
      messages: messages.map((message) => describeMessage(message)),
    });

    if (decision !== 'approve') {
      return 'Label change cancelled.';
    }

    const failure = await runBatchModify(
      {
        ids: messages.map((message) => message.id),
        addLabelIds,
        removeLabelIds,
      },
      accessToken,
    );

    if (failure) {
      return failure;
    }

    const confirmation = joinChangePhrases(changes, 'past', messages.length);

    return droppedCount > 0
      ? `${confirmation} ${droppedCount} of the requested messages no longer exist and were skipped.`
      : confirmation;
  },
  {
    name: 'modify_gmail_labels',
    description: `Add or remove labels on up to ${MAX_BULK_MESSAGE_IDS} of the user's Gmail messages at once. Archiving is removing the INBOX label. Label IDs are the system labels INBOX, UNREAD, and IMPORTANT, or an ID from list_gmail_labels. SPAM, STARRED, TRASH, SENT, and DRAFT are not accepted; use trash_gmail_messages to move messages to Trash. Requires user approval, except marking messages read or unread (changing only UNREAD), which executes directly.`,
    schema: modifyGmailLabelsSchema,
  },
);

type TrashOutcome = 'trashed' | 'missing' | { failed: string };

function buildTrashMessageUrl(messageId: string): string {
  return new URL(
    `${GMAIL_API_BASE_URL}/users/me/messages/${encodeURIComponent(messageId)}/trash`,
  ).toString();
}

// One documented POST per message. batchModify with addLabelIds: ['TRASH'] is
// unverified against a real token and undocumented, so the per-message
// endpoint is used; a slice 6 on-device probe can collapse this to one call.
// The pool must never throw for a GoogleApiError: an aborted pool would still
// let in-flight writes land while the agent is told nothing happened, so every
// item reports its own outcome and the counts are read back afterwards.
async function trashMessages(
  ids: string[],
  accessToken: string,
): Promise<{ trashed: number; missing: number; failed: string[] }> {
  const outcomes = await mapWithConcurrency(
    ids,
    METADATA_FETCH_CONCURRENCY,
    async (id): Promise<TrashOutcome> => {
      try {
        // messages.trash answers with the Message resource, but an empty body
        // maps to null and is still success.
        await fetchWithAuth(
          buildTrashMessageUrl(id),
          {
            method: 'POST',
          },
          accessToken,
        );

        return 'trashed';
      } catch (error) {
        if (error instanceof GoogleApiError) {
          return error.status === 404 ? 'missing' : { failed: error.message };
        }

        throw error;
      }
    },
  );

  return {
    trashed: outcomes.filter((outcome) => outcome === 'trashed').length,
    missing: outcomes.filter((outcome) => outcome === 'missing').length,
    failed: outcomes
      .filter(
        (outcome): outcome is { failed: string } => typeof outcome === 'object',
      )
      .map((outcome) => outcome.failed),
  };
}

export const trashGmailMessages = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    // A repeated ID would otherwise double a card row and a trash call.
    const messageIds = [...new Set(input.messageIds)];
    const { messages, droppedCount } = await fetchMessageMetadata(
      messageIds,
      accessToken,
    );
    // A message in Spam is not in Trash, so it is trashed like any other.
    const alreadyTrashed = messages.filter((message) =>
      message.labelIds?.includes('TRASH'),
    );
    const toTrash = messages.filter(
      (message) => !message.labelIds?.includes('TRASH'),
    );

    if (toTrash.length === 0) {
      const clauses = [
        droppedCount > 0
          ? formatCountClause(
              droppedCount,
              'no longer exists',
              'no longer exist',
            )
          : null,
        alreadyTrashed.length > 0
          ? formatCountClause(
              alreadyTrashed.length,
              'is already in Trash',
              'are already in Trash',
            )
          : null,
      ].filter((clause): clause is string => clause !== null);

      return `None of those messages need trashing: ${clauses.join(' and ')}.`;
    }

    const decision = interrupt<
      {
        action: 'trash_gmail_messages';
        description: string;
        current: { count: number };
        proposed: null;
        messages: Array<ReturnType<typeof describeMessage>>;
      },
      'approve' | 'reject'
    >({
      action: 'trash_gmail_messages',
      description: `Move ${formatMessageCount(toTrash.length)} to Trash.`,
      current: { count: toTrash.length },
      proposed: null,
      messages: toTrash.map((message) => describeMessage(message)),
    });

    if (decision !== 'approve') {
      return 'Trash cancelled.';
    }

    const { trashed, missing, failed } = await trashMessages(
      toTrash.map((message) => message.id),
      accessToken,
    );
    const sentences = [
      trashed > 0
        ? `Moved ${formatMessageCount(trashed)} to Trash. Messages in Trash can be restored for 30 days.`
        : 'No messages were moved to Trash.',
    ];

    if (missing > 0) {
      sentences.push(
        formatCountClause(
          missing,
          'of them no longer existed and was skipped.',
          'of them no longer existed and were skipped.',
        ),
      );
    }

    if (failed.length > 0) {
      // Google's message already ends with a period.
      sentences.push(`${failed.length} could not be moved: ${failed[0]}`);
    }

    if (alreadyTrashed.length > 0) {
      sentences.push(
        formatCountClause(
          alreadyTrashed.length,
          'of the requested messages was already in Trash.',
          'of the requested messages were already in Trash.',
        ),
      );
    }

    if (droppedCount > 0) {
      sentences.push(
        formatCountClause(
          droppedCount,
          'of the requested messages no longer exists.',
          'of the requested messages no longer exist.',
        ),
      );
    }

    return sentences.join(' ');
  },
  {
    name: 'trash_gmail_messages',
    description: `Move up to ${MAX_BULK_MESSAGE_IDS} of the user's Gmail messages to Trash at once, where they can be restored for 30 days. Messages in Spam are not in Trash and are moved like any other. Requires user approval.`,
    schema: z.object({
      messageIds: z
        .array(z.string().trim().regex(GMAIL_ID_PATTERN))
        .min(1)
        .max(MAX_BULK_MESSAGE_IDS)
        .describe(
          `The message IDs to move to Trash, obtained from search_gmail or get_gmail_thread. 1 to ${MAX_BULK_MESSAGE_IDS} IDs.`,
        ),
    }),
  },
);

function buildCreateLabelRequestBody(name: string): Record<string, string> {
  return {
    name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
  };
}

export const createGmailLabel = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);

    let label: GmailLabel | null;

    try {
      label = await fetchWithAuth<GmailLabel>(
        buildLabelsUrl(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildCreateLabelRequestBody(input.name)),
        },
        accessToken,
      );
    } catch (error) {
      // Google answers 409 for a duplicate name, including a case-insensitive
      // match or a collision with a system label.
      if (error instanceof GoogleApiError && error.status === 409) {
        return `A label named "${input.name}" already exists. Call list_gmail_labels to get its ID.`;
      }

      throw error;
    }

    if (!label) {
      return 'Google did not return the created label. Call list_gmail_labels to check whether it was created.';
    }

    const name = label.name?.replace(/\s+/g, ' ').trim() || input.name;

    return `Created label "${name}" (id: ${label.id})`;
  },
  {
    name: 'create_gmail_label',
    description:
      'Create a new Gmail label for the user. Call list_gmail_labels first and only create a label when none with that name exists. Nested labels use "/" in the name, as in "Housing/Lease".',
    schema: z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(225)
        .describe('The label name, for example "Housing" or "Housing/Lease".'),
    }),
  },
);

export const gmailTools = [
  listGmailLabels,
  searchGmail,
  getGmailMessage,
  getGmailThread,
  modifyGmailLabels,
  trashGmailMessages,
  createGmailLabel,
];
