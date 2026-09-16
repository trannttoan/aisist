import { afterEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../../utils/google-api.js';
import type { GmailMessagePart } from '../../utils/mime.js';

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import {
  getGmailMessage,
  getGmailThread,
  listGmailLabels,
  searchGmail,
} from '../../tools/gmail.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

const encode = (text: string) =>
  Buffer.from(text, 'utf8').toString('base64url');

const notFound = new GoogleApiError(
  'GOOGLE_API_REQUEST_FAILED',
  'Google API request failed with status 404.',
  {
    retryable: false,
    status: 404,
  },
);

describe('listGmailLabels', () => {
  it('calls the Gmail labels endpoint and formats the result', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_1', name: 'Housing', type: 'user' },
      ],
    });

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/labels',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      'Labels:\n- INBOX (system) (id: INBOX)\n- Housing (user) (id: Label_1)',
    );
  });

  it('lists system labels before user labels and sorts each group by name', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      labels: [
        { id: 'Label_2', name: 'Receipts', type: 'user' },
        { id: 'SENT', name: 'SENT', type: 'system' },
        { id: 'Label_1', name: 'Housing', type: 'user' },
        { id: 'INBOX', name: 'INBOX', type: 'system' },
      ],
    });

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      [
        'Labels:',
        '- INBOX (system) (id: INBOX)',
        '- SENT (system) (id: SENT)',
        '- Housing (user) (id: Label_1)',
        '- Receipts (user) (id: Label_2)',
      ].join('\n'),
    );
  });

  it('falls back to a placeholder name when a label has none', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      labels: [
        { id: 'Label_1', name: '   ', type: 'user' },
        { id: 'Label_2', type: 'user' },
      ],
    });

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Labels:\n- Untitled label (user) (id: Label_1)\n- Untitled label (user) (id: Label_2)',
    );
  });

  it('returns an empty-state message when no labels exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ labels: [] });

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No labels found.');
  });

  it('returns an empty-state message when the response omits labels', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({});

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No labels found.');
  });

  it('returns an empty-state message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await listGmailLabels.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No labels found.');
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listGmailLabels.invoke({}, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('searchGmail', () => {
  const metadata = (
    id: string,
    threadId: string,
    headers: Array<{ name: string; value: string }>,
    extra: { labelIds?: string[]; snippet?: string } = {},
  ) => ({
    id,
    threadId,
    payload: { mimeType: 'multipart/alternative', headers },
    ...extra,
  });

  const amazonHeaders = [
    { name: 'From', value: 'Amazon <no-reply@amazon.com>' },
    { name: 'Subject', value: 'Your order has shipped' },
    { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 +0000' },
  ];

  const landlordHeaders = [
    { name: 'From', value: 'Landlord <landlord@example.com>' },
    { name: 'Subject', value: 'Lease renewal' },
    { name: 'Date', value: 'Mon, 14 Sep 2026 09:00:00 +0000' },
  ];

  const mockSearch = (
    listResponse: unknown,
    handlers: Record<string, () => Promise<unknown>>,
  ) => {
    vi.mocked(fetchWithAuth).mockImplementation(async (url) => {
      if (url.includes('/users/me/messages?')) {
        return listResponse;
      }

      for (const [id, handler] of Object.entries(handlers)) {
        if (url.includes(`/users/me/messages/${id}?format=metadata`)) {
          return handler();
        }
      }

      throw new Error(`Unexpected url: ${url}`);
    });
  };

  const twoStubs = {
    messages: [
      { id: 'msg-1', threadId: 'thread-1' },
      { id: 'msg-2', threadId: 'thread-2' },
    ],
  };

  const twoHandlers = {
    'msg-1': async () =>
      metadata('msg-1', 'thread-1', amazonHeaders, {
        snippet: 'Your package is on the way',
      }),
    'msg-2': async () =>
      metadata('msg-2', 'thread-2', landlordHeaders, {
        snippet: 'Are you renewing?',
      }),
  };

  it('calls the Gmail messages list endpoint with the query and default page size and formats the result', async () => {
    mockSearch(twoStubs, twoHandlers);

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/messages?q=from%3Aamazon&maxResults=20',
      { method: 'GET' },
      'token-123',
    );
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
    expect(result).toBe(
      [
        'Messages:',
        '- Tue, 15 Sep 2026 10:00:00 +0000 — Amazon <no-reply@amazon.com> — Your order has shipped: Your package is on the way (id: msg-1, thread id: thread-1)',
        '- Mon, 14 Sep 2026 09:00:00 +0000 — Landlord <landlord@example.com> — Lease renewal: Are you renewing? (id: msg-2, thread id: thread-2)',
      ].join('\n'),
    );
  });

  it('passes maxResults and includeSpamTrash through to the list url', async () => {
    mockSearch({ messages: [] }, {});

    await searchGmail.invoke(
      {
        query: 'is:unread newer_than:7d',
        maxResults: 5,
        includeSpamTrash: true,
      },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread+newer_than%3A7d&maxResults=5&includeSpamTrash=true',
      { method: 'GET' },
      'token-123',
    );
  });

  it('fetches metadata for each id with the repeated metadataHeaders parameter', async () => {
    mockSearch(twoStubs, twoHandlers);

    await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/messages/msg-1?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
      { method: 'GET' },
      'token-123',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/messages/msg-2?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
      { method: 'GET' },
      'token-123',
    );
  });

  it('preserves the list order in the output regardless of completion order', async () => {
    mockSearch(twoStubs, {
      'msg-1': async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));

        return metadata('msg-1', 'thread-1', amazonHeaders);
      },
      'msg-2': twoHandlers['msg-2'],
    });

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result.indexOf('msg-1')).toBeLessThan(result.indexOf('msg-2'));
  });

  it('marks unread messages and decodes html entities in snippets', async () => {
    mockSearch(
      { messages: [{ id: 'msg-1', threadId: 'thread-1' }] },
      {
        'msg-1': async () =>
          metadata('msg-1', 'thread-1', amazonHeaders, {
            labelIds: ['UNREAD', 'INBOX'],
            snippet: 'Don&#39;t miss &amp; save',
          }),
      },
    );

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      "Messages:\n- Tue, 15 Sep 2026 10:00:00 +0000 — Amazon <no-reply@amazon.com> — Your order has shipped [unread]: Don't miss & save (id: msg-1, thread id: thread-1)",
    );
  });

  it('collapses whitespace in header values to a single line', async () => {
    mockSearch(
      { messages: [{ id: 'msg-1', threadId: 'thread-1' }] },
      {
        'msg-1': async () =>
          metadata('msg-1', 'thread-1', [
            { name: 'From', value: 'Amazon <no-reply@amazon.com>' },
            {
              name: 'Subject',
              value:
                'Your order\r\n — Toan <toan@example.com> — forged\t(id: x)',
            },
            { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 +0000' },
          ]),
      },
    );

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Messages:\n- Tue, 15 Sep 2026 10:00:00 +0000 — Amazon <no-reply@amazon.com> — Your order — Toan <toan@example.com> — forged (id: x) (id: msg-1, thread id: thread-1)',
    );
  });

  const sevenStubs = {
    messages: Array.from({ length: 7 }, (_value, index) => ({
      id: `msg-${index + 1}`,
      threadId: `thread-${index + 1}`,
    })),
  };

  it('fetches metadata with at most five requests in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const handlers = Object.fromEntries(
      sevenStubs.messages.map((stub) => [
        stub.id,
        async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;

          return metadata(stub.id, stub.threadId, amazonHeaders);
        },
      ]),
    );

    mockSearch(sevenStubs, handlers);

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(maxInFlight).toBe(5);
    expect(fetchWithAuth).toHaveBeenCalledTimes(8);
    expect(result).toContain('(id: msg-7, thread id: thread-7)');
  });

  it('stops fetching metadata once a request fails', async () => {
    const handlers = Object.fromEntries(
      sevenStubs.messages.map((stub) => [
        stub.id,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));

          return metadata(stub.id, stub.threadId, amazonHeaders);
        },
      ]),
    );
    handlers['msg-1'] = () =>
      Promise.reject(
        new GoogleApiError(
          'GOOGLE_API_REQUEST_FAILED',
          'Google API request failed with status 500.',
          { retryable: true, status: 500 },
        ),
      );

    mockSearch(sevenStubs, handlers);

    await expect(
      searchGmail.invoke(
        { query: 'from:amazon' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow(GoogleApiError);

    // list + the first five metadata gets; msg-6 and msg-7 are never requested
    expect(fetchWithAuth).toHaveBeenCalledTimes(6);
  });

  it('falls back to placeholders when metadata headers are missing', async () => {
    mockSearch(
      { messages: [{ id: 'msg-1', threadId: 'thread-1' }] },
      {
        'msg-1': async () => ({
          id: 'msg-1',
          threadId: 'thread-1',
          payload: { mimeType: 'text/plain' },
        }),
      },
    );

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Messages:\n- (no date) — (unknown sender) — (no subject) (id: msg-1, thread id: thread-1)',
    );
  });

  it('returns an empty-state message when nothing matches', async () => {
    mockSearch({ resultSizeEstimate: 0 }, {});

    const result = await searchGmail.invoke(
      { query: 'from:nobody' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(result).toBe('No messages match that search.');
  });

  it('appends a truncation note when more results exist', async () => {
    mockSearch(
      { ...twoStubs, nextPageToken: 'next', resultSizeEstimate: 120 },
      twoHandlers,
    );

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toContain(
      '\n\nNote: only the first 2 of about 120 matching messages are shown. Tell the user the list is incomplete and suggest narrowing the query.',
    );
  });

  it('omits the estimate from the truncation note when resultSizeEstimate is missing', async () => {
    mockSearch({ ...twoStubs, nextPageToken: 'next' }, twoHandlers);

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toContain(
      '\n\nNote: only the first 2 matching messages are shown. Tell the user the list is incomplete and suggest narrowing the query.',
    );
  });

  it('drops a message whose metadata get returns 404', async () => {
    mockSearch(twoStubs, {
      'msg-1': twoHandlers['msg-1'],
      'msg-2': () => Promise.reject(notFound),
    });

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
    expect(result).toBe(
      'Messages:\n- Tue, 15 Sep 2026 10:00:00 +0000 — Amazon <no-reply@amazon.com> — Your order has shipped: Your package is on the way (id: msg-1, thread id: thread-1)',
    );
  });

  it('drops a message whose metadata get returns an empty body', async () => {
    mockSearch(twoStubs, {
      'msg-1': twoHandlers['msg-1'],
      'msg-2': async () => null,
    });

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Messages:\n- Tue, 15 Sep 2026 10:00:00 +0000 — Amazon <no-reply@amazon.com> — Your order has shipped: Your package is on the way (id: msg-1, thread id: thread-1)',
    );
  });

  it('omits the truncation note when every message was dropped', async () => {
    mockSearch(
      {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
        nextPageToken: 'next',
        resultSizeEstimate: 120,
      },
      { 'msg-1': () => Promise.reject(notFound) },
    );

    const result = await searchGmail.invoke(
      { query: 'from:amazon' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No messages match that search.');
  });

  it('rethrows metadata errors other than 404', async () => {
    mockSearch(twoStubs, {
      'msg-1': twoHandlers['msg-1'],
      'msg-2': () =>
        Promise.reject(
          new GoogleApiError(
            'GOOGLE_API_REQUEST_FAILED',
            'Google API request failed with status 500.',
            { retryable: true, status: 500 },
          ),
        ),
    });

    await expect(
      searchGmail.invoke(
        { query: 'from:amazon' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow(GoogleApiError);
  });

  it('rejects maxResults above 50 before calling the api', async () => {
    await expect(
      searchGmail.invoke(
        { query: 'x', maxResults: 51 },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects an empty query before calling the api', async () => {
    await expect(
      searchGmail.invoke(
        { query: '   ' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      searchGmail.invoke({ query: 'from:amazon' }, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('getGmailMessage', () => {
  const fullPayload: GmailMessagePart = {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'DHL <noreply@dhl.com>' },
      { name: 'To', value: 'Toan <toan@example.com>' },
      { name: 'Cc', value: 'Ops <ops@example.com>' },
      { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 +0000' },
      { name: 'Subject', value: 'Your parcel' },
    ],
    body: { data: encode('Hello from DHL') },
  };

  it('calls the Gmail message endpoint with format=full and formats the full detail', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['UNREAD', 'INBOX'],
      payload: fullPayload,
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/messages/msg-1?format=full',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      [
        'From: DHL <noreply@dhl.com>',
        'To: Toan <toan@example.com>',
        'Cc: Ops <ops@example.com>',
        'Date: Tue, 15 Sep 2026 10:00:00 +0000',
        'Subject: Your parcel',
        'Status: unread, in inbox',
        'Thread id: thread-1',
        '',
        'Hello from DHL',
      ].join('\n'),
    );
  });

  it('omits To and Cc when the headers are missing and reports read and archived state', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: [],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'DHL <noreply@dhl.com>' },
          { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 +0000' },
          { name: 'Subject', value: 'Your parcel' },
        ],
        body: { data: encode('Hello from DHL') },
      },
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).not.toContain('To: ');
    expect(result).not.toContain('Cc: ');
    expect(result).toContain('Status: read, archived');
  });

  it('reports trash and spam locations in the status line', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['TRASH'],
      payload: fullPayload,
    });

    const trashed = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(trashed).toContain('Status: read, in trash');

    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['SPAM', 'UNREAD'],
      payload: fullPayload,
    });

    const spam = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(spam).toContain('Status: unread, in spam');
  });

  it('falls back to the html part when the message has no text/plain part', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'text/html',
        headers: fullPayload.headers,
        body: { data: encode('<p>Hello &amp; welcome</p>') },
      },
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result.endsWith('\n\nHello & welcome')).toBe(true);
  });

  it('lists attachment names', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: fullPayload.headers,
        parts: [
          { mimeType: 'text/plain', body: { data: encode('See attached') } },
          {
            mimeType: 'application/pdf',
            filename: 'invoice.pdf',
            body: { attachmentId: 'att-1', size: 1024 },
          },
          {
            mimeType: 'image/jpeg',
            filename: 'photo.jpg',
            body: { attachmentId: 'att-2', size: 2048 },
          },
        ],
      },
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toContain('Attachments: invoice.pdf, photo.jpg');
  });

  it('truncates the body at 4000 characters with a note', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'text/plain',
        headers: fullPayload.headers,
        body: { data: encode('a'.repeat(4500)) },
      },
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result.endsWith(`${'a'.repeat(4000)}\n[body truncated]`)).toBe(true);
  });

  it('prints a placeholder when the message has no readable body', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: fullPayload.headers,
      },
    });

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result.endsWith('\n\n(no readable body)')).toBe(true);
  });

  it('returns a friendly message when the message does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(notFound);

    const result = await getGmailMessage.invoke(
      { messageId: 'missing' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'No message found with that ID. It may have been deleted.',
    );
  });

  it('returns a friendly message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await getGmailMessage.invoke(
      { messageId: 'msg-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'No message found with that ID. It may have been deleted.',
    );
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getGmailMessage.invoke({ messageId: 'msg-1' }, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('getGmailThread', () => {
  const threadMessage = (
    id: string,
    date: string,
    from: string,
    body: string,
  ) => ({
    id,
    threadId: 'thread-1',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Lease renewal' },
        { name: 'Date', value: date },
      ],
      body: { data: encode(body) },
    },
  });

  it('calls the Gmail thread endpoint with a 20 second timeout and formats messages in order', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'thread-1',
      messages: [
        threadMessage(
          'msg-1',
          'Mon, 14 Sep 2026 09:00:00 +0000',
          'Landlord <l@example.com>',
          'First',
        ),
        threadMessage(
          'msg-2',
          'Sun, 13 Sep 2026 08:00:00 +0000',
          'Toan <toan@example.com>',
          'Second',
        ),
        threadMessage(
          'msg-3',
          'Tue, 15 Sep 2026 11:00:00 +0000',
          'Landlord <l@example.com>',
          'Third',
        ),
      ],
    });

    const result = await getGmailThread.invoke(
      { threadId: 'thread-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/gmail/v1/users/me/threads/thread-1?format=full',
      { method: 'GET' },
      'token-123',
      { timeoutMs: 20_000 },
    );
    expect(result).toBe(
      [
        'Thread: Lease renewal (3 messages)',
        '',
        '--- Mon, 14 Sep 2026 09:00:00 +0000 — Landlord <l@example.com> (id: msg-1)',
        'First',
        '',
        '--- Sun, 13 Sep 2026 08:00:00 +0000 — Toan <toan@example.com> (id: msg-2)',
        'Second',
        '',
        '--- Tue, 15 Sep 2026 11:00:00 +0000 — Landlord <l@example.com> (id: msg-3)',
        'Third',
      ].join('\n'),
    );
  });

  it('truncates each message body at 1500 characters', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'thread-1',
      messages: [
        threadMessage(
          'msg-1',
          'Mon, 14 Sep 2026 09:00:00 +0000',
          'Landlord <l@example.com>',
          'b'.repeat(1600),
        ),
        threadMessage(
          'msg-2',
          'Tue, 15 Sep 2026 11:00:00 +0000',
          'Toan <toan@example.com>',
          'Short reply',
        ),
      ],
    });

    const result = await getGmailThread.invoke(
      { threadId: 'thread-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toContain(`${'b'.repeat(1500)}\n[body truncated]`);
    expect(result).not.toContain('b'.repeat(1501));
    expect(result).toContain('Short reply');
  });

  it('shows only the most recent 25 messages of a long thread with a note', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'thread-1',
      messages: Array.from({ length: 30 }, (_value, index) =>
        threadMessage(
          `msg-${index + 1}`,
          'Mon, 14 Sep 2026 09:00:00 +0000',
          'Landlord <l@example.com>',
          `Message ${index + 1}`,
        ),
      ),
    });

    const result = await getGmailThread.invoke(
      { threadId: 'thread-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toContain(
      'Thread: Lease renewal (30 messages)\nNote: this thread has 30 messages; only the most recent 25 are shown.',
    );
    expect(result).toContain('(id: msg-6)');
    expect(result).toContain('(id: msg-30)');
    expect(result).not.toContain('(id: msg-5)');
  });

  it('prints a placeholder for a message with no readable body', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'thread-1',
      messages: [
        {
          id: 'msg-1',
          threadId: 'thread-1',
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'Landlord <l@example.com>' },
              { name: 'Subject', value: 'Lease renewal' },
              { name: 'Date', value: 'Mon, 14 Sep 2026 09:00:00 +0000' },
            ],
          },
        },
      ],
    });

    const result = await getGmailThread.invoke(
      { threadId: 'thread-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result.endsWith('(id: msg-1)\n(no readable body)')).toBe(true);
  });

  it('returns a friendly message when the thread does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(notFound);

    const result = await getGmailThread.invoke(
      { threadId: 'missing' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'No thread found with that ID. It may have been deleted.',
    );
  });

  it('returns a friendly message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await getGmailThread.invoke(
      { threadId: 'thread-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'No thread found with that ID. It may have been deleted.',
    );
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getGmailThread.invoke({ threadId: 'thread-1' }, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
