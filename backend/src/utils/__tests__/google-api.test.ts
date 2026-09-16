import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../auth.js';
import { GoogleApiError, fetchWithAuth } from '../google-api.js';

describe('fetchWithAuth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('adds the bearer token header and parses the JSON response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'event-1' }] }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      }),
    );

    const result = await fetchWithAuth<{ items: Array<{ id: string }> }>(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        headers: {
          'x-test-header': 'present',
        },
        method: 'GET',
      },
      'calendar-access-token',
    );

    expect(result).toEqual({ items: [{ id: 'event-1' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      }),
    );

    const requestInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(requestInit.headers);

    expect(headers.get('authorization')).toBe('Bearer calendar-access-token');
    expect(headers.get('x-test-header')).toBe('present');
  });

  it('maps 401 responses to AisistAuthError', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 401,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'expired-token',
      ),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_INVALID_TOKEN',
      retryable: false,
      status: 401,
    });
  });

  it('maps 403 responses to insufficient scope errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 403,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'missing-scope-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_INSUFFICIENT_SCOPE',
      retryable: false,
      status: 403,
    });
  });

  it('maps a 403 SERVICE_DISABLED response to a service disabled error', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message:
              'Tasks API has not been used in project 123 before or it is disabled.',
            status: 'PERMISSION_DENIED',
            details: [{ reason: 'SERVICE_DISABLED' }],
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 403,
        },
      ),
    );

    const error = await fetchWithAuth(
      'https://www.googleapis.com/tasks/v1/users/@me/lists',
      {},
      'valid-token',
    ).catch((thrown: unknown) => thrown as GoogleApiError);

    expect(error).toMatchObject<Partial<GoogleApiError>>({
      code: 'GOOGLE_API_SERVICE_DISABLED',
      retryable: false,
      status: 403,
    });
    expect(error.message).toContain('not enabled for the project');
    expect(error.message).toContain('Signing in again will not help');
    expect(error.message).toContain('has not been used in project 123');
  });

  it('surfaces the google message for a 403 scope failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 403,
        },
      ),
    );

    const error = await fetchWithAuth(
      'https://www.googleapis.com/tasks/v1/users/@me/lists',
      {},
      'narrow-token',
    ).catch((thrown: unknown) => thrown as GoogleApiError);

    expect(error).toMatchObject<Partial<GoogleApiError>>({
      code: 'GOOGLE_API_INSUFFICIENT_SCOPE',
      status: 403,
    });
    expect(error.message).toContain('sign in again');
    expect(error.message).toContain('Gmail');
    expect(error.message).toContain('insufficient authentication scopes');
  });

  it('maps 429 responses to retryable rate limit errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 429,
      }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_RATE_LIMITED',
      retryable: true,
      status: 429,
    });
  });

  it('maps network failures to retryable request errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_REQUEST_FAILED',
      retryable: true,
      status: 503,
    });
  });

  it('returns null for 204 no-content responses', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await fetchWithAuth(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1',
      { method: 'DELETE' },
      'valid-token',
    );

    expect(result).toBeNull();
  });

  it('throws on invalid JSON responses', async () => {
    fetchMock.mockResolvedValue(new Response('not json {{{', { status: 200 }));

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_REQUEST_FAILED',
      retryable: true,
      status: 502,
    });
  });

  it('aborts the request after the configured timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            );
          });
        }),
    );

    await expect(
      fetchWithAuth(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {},
        'valid-token',
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_REQUEST_FAILED',
      retryable: true,
      status: 503,
    });
  });
});
