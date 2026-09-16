import type { AuthSessionResult } from 'expo-auth-session';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 5000;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT =
  'https://openidconnect.googleapis.com/v1/userinfo';

export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.modify',
];

export type AuthSessionData = {
  accessToken: string;
  refreshToken: string;
  expiryAt: string;
  email: string;
  scopes: string[];
};

type GoogleUserInfo = {
  email?: string;
};

type RefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
};

export type GoogleAuthErrorCode =
  | 'cancelled'
  | 'exchange_failed'
  | 'insufficient_scope'
  | 'missing_refresh_token'
  | 'request_timeout'
  | 'refresh_force_reauth'
  | 'refresh_timeout'
  | 'refresh_transient'
  | 'userinfo_failed';

export class GoogleAuthError extends Error {
  constructor(
    public readonly code: GoogleAuthErrorCode,
    message: string,
    public readonly forceReauth = false,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export function getGoogleIosClientId(): string {
  return process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? '';
}

export function getGoogleAuthRequestConfig() {
  const iosClientId = getGoogleIosClientId();

  if (!iosClientId) {
    return null;
  }

  return {
    iosClientId,
    scopes: GOOGLE_SCOPES,
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  } as const;
}

export async function buildSessionFromAuthResponse(
  response: AuthSessionResult,
): Promise<AuthSessionData> {
  if (response.type === 'cancel' || response.type === 'dismiss') {
    throw new GoogleAuthError('cancelled', 'Google sign-in was cancelled.');
  }

  if (response.type !== 'success' || !response.authentication?.accessToken) {
    const errorDescription =
      response.type === 'error'
        ? (response.error?.description ??
          response.params.error_description ??
          response.params.error ??
          'Google sign-in failed during token exchange.')
        : 'Google sign-in failed during token exchange.';

    throw new GoogleAuthError('exchange_failed', errorDescription);
  }

  if (!response.authentication.refreshToken) {
    throw new GoogleAuthError(
      'missing_refresh_token',
      'Google did not return a refresh token. Sign in again to retry.',
    );
  }

  const email = await fetchGoogleUserEmail(response.authentication.accessToken);
  const scopeString = response.authentication.scope ?? response.params.scope;
  const grantedScopes = scopeString
    ? parseGrantedScopes(scopeString)
    : [...GOOGLE_SCOPES];
  const missingScopes = GOOGLE_SCOPES.filter((s) => !grantedScopes.includes(s));

  if (missingScopes.length > 0) {
    throw new GoogleAuthError(
      'insufficient_scope',
      'Aisist needs calendar, tasks, and Gmail access to work. Please sign in again and grant all permissions.',
      true,
    );
  }

  return {
    accessToken: response.authentication.accessToken,
    refreshToken: response.authentication.refreshToken,
    expiryAt: buildExpiryAt(
      response.authentication.issuedAt,
      response.authentication.expiresIn,
    ),
    email,
    scopes: grantedScopes,
  };
}

export function parseGrantedScopes(scope: string | undefined): string[] {
  if (!scope || scope.trim() === '') {
    return [];
  }

  return scope.trim().split(/\s+/);
}

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  refreshToken: string;
}): Promise<
  Pick<AuthSessionData, 'accessToken' | 'refreshToken' | 'expiryAt'>
> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  });

  let response: Response;

  try {
    response = await fetchWithTimeout(
      GOOGLE_TOKEN_ENDPOINT,
      {
        body: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      },
      REQUEST_TIMEOUT_MS,
      'refresh_timeout',
    );
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw error;
    }

    throw new GoogleAuthError(
      'refresh_transient',
      'Google token refresh failed. Try again shortly.',
    );
  }

  if (response.status === 400 || response.status === 401) {
    throw new GoogleAuthError(
      'refresh_force_reauth',
      'Your Google session expired. Sign in again.',
      true,
    );
  }

  if (!response.ok) {
    throw new GoogleAuthError(
      'refresh_transient',
      `Google token refresh failed with status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as RefreshResponse;

  if (!payload.access_token) {
    throw new GoogleAuthError(
      'refresh_transient',
      'Google token refresh did not return an access token.',
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? input.refreshToken,
    expiryAt: buildExpiryAt(undefined, payload.expires_in),
  };
}

export function isForceReauthError(error: unknown): boolean {
  return error instanceof GoogleAuthError && error.forceReauth;
}

export function isRefreshTimeoutError(error: unknown): boolean {
  return error instanceof GoogleAuthError && error.code === 'refresh_timeout';
}

function buildExpiryAt(
  issuedAtSeconds?: number,
  expiresInSeconds?: number,
): string {
  const issuedAtMs = (issuedAtSeconds ?? Math.floor(Date.now() / 1000)) * 1000;
  const expiresInMs =
    (expiresInSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS) * 1000;

  return new Date(issuedAtMs + expiresInMs).toISOString();
}

async function fetchGoogleUserEmail(accessToken: string): Promise<string> {
  const response = await fetchWithTimeout(
    GOOGLE_USERINFO_ENDPOINT,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: 'GET',
    },
    REQUEST_TIMEOUT_MS,
    'request_timeout',
  );

  if (!response.ok) {
    throw new GoogleAuthError(
      'userinfo_failed',
      `Google user info request failed with status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as GoogleUserInfo;

  if (!payload.email) {
    throw new GoogleAuthError(
      'userinfo_failed',
      'Google user info response did not include an email address.',
    );
  }

  return payload.email;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutCode: 'refresh_timeout' | 'request_timeout',
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (timeoutCode === 'refresh_timeout') {
        throw new GoogleAuthError(
          'refresh_timeout',
          'Google token refresh timed out. Retrying once.',
        );
      }

      throw new GoogleAuthError(
        'request_timeout',
        'Google sign-in request timed out. Try again.',
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
