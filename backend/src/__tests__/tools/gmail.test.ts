import { afterEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth } from '../../utils/google-api.js';

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import { listGmailLabels } from '../../tools/gmail.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

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
