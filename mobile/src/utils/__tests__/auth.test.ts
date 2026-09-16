import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import {
  GOOGLE_SCOPES,
  GoogleAuthError,
  buildSessionFromAuthResponse,
  isForceReauthError,
  isRefreshTimeoutError,
  refreshGoogleAccessToken,
} from '../auth';

import type { AuthSessionResult } from 'expo-auth-session';

const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  global.fetch = fetchMock;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-15T10:00:00Z'));
});

afterEach(() => {
  fetchMock.mockReset();
  jest.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

const ALL_SCOPES_STRING = GOOGLE_SCOPES.join(' ');

function successAuthResult(
  overrides: Record<string, unknown> = {},
): AuthSessionResult {
  return {
    type: 'success',
    authentication: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: ALL_SCOPES_STRING,
      ...overrides,
    },
    params: {},
    url: 'https://example.com/callback',
  } as unknown as AuthSessionResult;
}

describe('buildSessionFromAuthResponse', () => {
  it('returns a session with email on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    const session = await buildSessionFromAuthResponse(successAuthResult());

    expect(session).toEqual({
      accessToken: 'access-token',
      email: 'user@example.com',
      expiryAt: expect.any(String),
      refreshToken: 'refresh-token',
      scopes: GOOGLE_SCOPES,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openidconnect.googleapis.com/v1/userinfo',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
        method: 'GET',
      }),
    );
  });

  it('throws cancelled for cancel result', async () => {
    const result = { type: 'cancel' } as AuthSessionResult;

    await expect(buildSessionFromAuthResponse(result)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('throws cancelled for dismiss result', async () => {
    const result = { type: 'dismiss' } as AuthSessionResult;

    await expect(buildSessionFromAuthResponse(result)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('throws exchange_failed when type is error', async () => {
    const result = {
      type: 'error',
      error: { description: 'access_denied' },
      params: {},
    } as unknown as AuthSessionResult;

    await expect(buildSessionFromAuthResponse(result)).rejects.toMatchObject({
      code: 'exchange_failed',
      message: 'access_denied',
    });
  });

  it('throws missing_refresh_token when refreshToken is absent', async () => {
    const result = successAuthResult({ refreshToken: null });

    await expect(buildSessionFromAuthResponse(result)).rejects.toMatchObject({
      code: 'missing_refresh_token',
    });
  });

  it('throws userinfo_failed when userinfo endpoint returns non-ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 403));

    await expect(
      buildSessionFromAuthResponse(successAuthResult()),
    ).rejects.toMatchObject({
      code: 'userinfo_failed',
    });
  });

  it('throws insufficient_scope when granted scopes do not cover all required scopes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    await expect(
      buildSessionFromAuthResponse(
        successAuthResult({
          scope: 'openid https://www.googleapis.com/auth/userinfo.email',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'insufficient_scope',
      forceReauth: true,
    });
  });

  it('throws insufficient_scope when only the tasks scope is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    const grantedWithoutTasks = GOOGLE_SCOPES.filter(
      (scope) => scope !== 'https://www.googleapis.com/auth/tasks',
    ).join(' ');

    await expect(
      buildSessionFromAuthResponse(
        successAuthResult({ scope: grantedWithoutTasks }),
      ),
    ).rejects.toMatchObject({
      code: 'insufficient_scope',
      forceReauth: true,
    });
  });

  it('throws insufficient_scope when only the gmail scope is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    const grantedWithoutGmail = GOOGLE_SCOPES.filter(
      (scope) => scope !== 'https://www.googleapis.com/auth/gmail.modify',
    ).join(' ');

    await expect(
      buildSessionFromAuthResponse(
        successAuthResult({ scope: grantedWithoutGmail }),
      ),
    ).rejects.toMatchObject({
      code: 'insufficient_scope',
      forceReauth: true,
    });
  });

  it('assumes all requested scopes granted when scope field is absent (RFC 6749 §5.1)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    const session = await buildSessionFromAuthResponse(
      successAuthResult({ scope: undefined }),
    );

    expect(session.scopes).toEqual(GOOGLE_SCOPES);
  });

  it('falls back to params.scope when authentication.scope is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'user@example.com' }));

    const result = {
      type: 'success',
      authentication: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        issuedAt: Math.floor(Date.now() / 1000),
        expiresIn: 3600,
      },
      params: { scope: ALL_SCOPES_STRING },
    } as unknown as AuthSessionResult;

    const session = await buildSessionFromAuthResponse(result);

    expect(session.scopes).toEqual(GOOGLE_SCOPES);
  });

  it('throws userinfo_failed when response has no email', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sub: '123' }));

    await expect(
      buildSessionFromAuthResponse(successAuthResult()),
    ).rejects.toMatchObject({
      code: 'userinfo_failed',
      message: expect.stringContaining('email'),
    });
  });
});

describe('refreshGoogleAccessToken', () => {
  const refreshInput = {
    clientId: 'ios-client-id',
    refreshToken: 'refresh-token',
  };

  it('returns fresh tokens on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'new-access',
        expires_in: 3600,
        refresh_token: 'new-refresh',
      }),
    );

    const result = await refreshGoogleAccessToken(refreshInput);

    expect(result).toEqual({
      accessToken: 'new-access',
      expiryAt: expect.any(String),
      refreshToken: 'new-refresh',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('preserves the original refresh token when Google omits it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access', expires_in: 3600 }),
    );

    const result = await refreshGoogleAccessToken(refreshInput);

    expect(result.refreshToken).toBe('refresh-token');
  });

  it('throws refresh_force_reauth on 400', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_force_reauth',
      forceReauth: true,
    });
  });

  it('throws refresh_force_reauth on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_force_reauth',
      forceReauth: true,
    });
  });

  it('throws refresh_transient on 5xx', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_transient',
    });
  });

  it('throws refresh_transient when response has no access_token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_type: 'Bearer' }));

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_transient',
      message: expect.stringContaining('access token'),
    });
  });

  it('throws refresh_timeout on AbortError', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_timeout',
    });
  });

  it('throws refresh_transient on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(refreshGoogleAccessToken(refreshInput)).rejects.toMatchObject({
      code: 'refresh_transient',
    });
  });
});

describe('error type guards', () => {
  it('isForceReauthError returns true for forceReauth errors', () => {
    expect(
      isForceReauthError(
        new GoogleAuthError('refresh_force_reauth', 'x', true),
      ),
    ).toBe(true);
  });

  it('isForceReauthError returns false for other GoogleAuthErrors', () => {
    expect(
      isForceReauthError(new GoogleAuthError('refresh_transient', 'x')),
    ).toBe(false);
  });

  it('isForceReauthError returns false for plain errors', () => {
    expect(isForceReauthError(new Error('x'))).toBe(false);
  });

  it('isRefreshTimeoutError returns true for refresh_timeout', () => {
    expect(
      isRefreshTimeoutError(new GoogleAuthError('refresh_timeout', 'x')),
    ).toBe(true);
  });

  it('isRefreshTimeoutError returns false for other codes', () => {
    expect(
      isRefreshTimeoutError(new GoogleAuthError('refresh_transient', 'x')),
    ).toBe(false);
  });
});
