import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';
import {
  decodeHtmlEntities,
  getHeader,
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

function describeMessage(message: GmailMessage): {
  date: string;
  from: string;
  subject: string;
} {
  return {
    date: getHeader(message.payload, 'Date')?.trim() || '(no date)',
    from: getHeader(message.payload, 'From')?.trim() || '(unknown sender)',
    subject: getHeader(message.payload, 'Subject')?.trim() || '(no subject)',
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

export const gmailTools = [listGmailLabels, searchGmail];
