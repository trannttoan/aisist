import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';
import {
  decodeHtmlEntities,
  extractTextBody,
  getHeader,
  listAttachmentNames,
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

// Nothing downstream truncates tool output, so this cap is the only guard
// against a newsletter filling the model's context window.
const MAX_MESSAGE_BODY_CHARS = 4000;

// A thread is replayed on every turn of the sitting, so 25 messages of 1,500
// characters (~40 KB) is the ceiling one catch-up call may add to the context.
const MAX_THREAD_MESSAGE_BODY_CHARS = 1500;
const MAX_THREAD_MESSAGES = 25;

const NO_READABLE_BODY = '(no readable body)';

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
  internalDate?: string;
  payload?: GmailMessagePart;
};

type GmailThread = {
  id?: string;
  messages?: GmailMessage[];
};

type ListMessagesResponse = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

function buildListLabelsUrl(): string {
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

  // metadataHeaders is a repeated parameter; a comma-joined value is ignored
  // and every row would degrade to its placeholder.
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
// regardless of which request finishes first.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;

        if (index >= items.length) {
          return;
        }

        results[index] = await fn(items[index]!, index);
      }
    },
  );

  await Promise.all(workers);

  return results;
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
      buildListLabelsUrl(),
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
    const fetched = await mapWithConcurrency(
      stubs,
      METADATA_FETCH_CONCURRENCY,
      async (stub) => {
        try {
          return await fetchWithAuth<GmailMessage>(
            buildMessageMetadataUrl(stub.id),
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
      'Get the full content of a single Gmail message, including its headers, attachment names, and body text (truncated for long messages). The output includes the thread ID for get_gmail_thread.',
    schema: z.object({
      messageId: z
        .string()
        .trim()
        .min(1)
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

    lines.push('');
    lines.push(`--- ${date} — ${from} (id: ${message.id})`);
    lines.push(
      truncateBody(
        extractTextBody(message.payload),
        MAX_THREAD_MESSAGE_BODY_CHARS,
      ) || NO_READABLE_BODY,
    );
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
      'Get every message in a Gmail thread in order, each with its date, sender, message ID, and body text (truncated per message). Use this to catch up on a conversation found with search_gmail.',
    schema: z.object({
      threadId: z
        .string()
        .trim()
        .min(1)
        .describe(
          'The thread ID, obtained from search_gmail or get_gmail_message.',
        ),
    }),
  },
);

export const gmailTools = [
  listGmailLabels,
  searchGmail,
  getGmailMessage,
  getGmailThread,
];
