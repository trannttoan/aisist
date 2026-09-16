import { afterEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../../utils/google-api.js';

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import { listGmailLabels, searchGmail } from '../../tools/gmail.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

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
