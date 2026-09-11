import { v5 as uuidv5 } from 'uuid';

// Must match backend/src/utils/thread.ts and mobile/src/utils/thread.ts —
// guarded by a test that reads the backend source.
export const AISIST_NAMESPACE = 'e587b8a0-3e1a-4c5d-9f2b-1a8c4d6e7f90';

export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const TOKENINFO_TIMEOUT_MS = 3000;

export class ProxyAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProxyAuthError';
    this.status = status;
  }
}

export function deriveThreadId(email: string): string {
  return uuidv5(email, AISIST_NAMESPACE);
}

export async function validateGoogleAccessToken(
  accessToken: string,
  tokeninfoUrl: string = GOOGLE_TOKENINFO_URL,
): Promise<{ email: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKENINFO_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${tokeninfoUrl}?access_token=${encodeURIComponent(accessToken)}`,
      { method: 'GET', signal: controller.signal },
    );
  } catch (error) {
    const timedOut =
      error instanceof DOMException && error.name === 'AbortError';
    throw new ProxyAuthError(
      503,
      timedOut
        ? 'Google token validation timed out. Retry the request.'
        : 'Google token validation failed due to a transient error. Retry the request.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 500) {
    throw new ProxyAuthError(
      503,
      'Google token validation is temporarily unavailable. Retry the request.',
    );
  }

  if (response.status >= 400) {
    throw new ProxyAuthError(
      401,
      'Google access token is invalid or expired. Sign in again.',
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    email?: unknown;
  } | null;
  const email = payload?.email;

  if (typeof email !== 'string' || !/^\S+@\S+$/.test(email.trim())) {
    throw new ProxyAuthError(
      401,
      'Google token validation response was missing a valid email.',
    );
  }

  return { email: email.trim().toLowerCase() };
}
