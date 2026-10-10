import { AisistAuthError } from './auth.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MESSAGE =
  'Google API rate limit reached. Retry the request shortly.';
const MAX_CONCURRENT_REQUESTS_PER_TOKEN = 5;
const RETRY_BASE_DELAY_MS = 1000;

// Google rate-limits per user and one model turn can issue dozens of tool
// calls, so requests sharing a token wait for one of a few slots.
const requestSlotsByToken = new Map<
  string,
  { active: number; waiting: Array<() => void> }
>();

async function acquireRequestSlot(accessToken: string): Promise<() => void> {
  const slots = requestSlotsByToken.get(accessToken) ?? {
    active: 0,
    waiting: [],
  };

  requestSlotsByToken.set(accessToken, slots);

  if (slots.active < MAX_CONCURRENT_REQUESTS_PER_TOKEN) {
    slots.active += 1;
  } else {
    await new Promise<void>((resolve) => slots.waiting.push(resolve));
  }

  return () => {
    const next = slots.waiting.shift();

    // A waiting request takes over the slot, so the count does not change.
    if (next) {
      next();
      return;
    }

    slots.active -= 1;

    if (slots.active === 0) {
      requestSlotsByToken.delete(accessToken);
    }
  };
}

type GoogleApiErrorCode =
  | 'GOOGLE_API_INSUFFICIENT_SCOPE'
  | 'GOOGLE_API_RATE_LIMITED'
  | 'GOOGLE_API_REQUEST_FAILED'
  | 'GOOGLE_API_SERVICE_DISABLED';

export class GoogleApiError extends Error {
  readonly code: GoogleApiErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: GoogleApiErrorCode,
    message: string,
    {
      retryable,
      status,
    }: {
      retryable: boolean;
      status: number;
    },
  ) {
    super(message);
    this.name = 'GoogleApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function isGoogleApiError(error: unknown): error is GoogleApiError {
  return error instanceof GoogleApiError;
}

// Only idempotent requests should pass retries: a timed-out write may still
// have landed, and repeating a create would post it twice.
export async function fetchWithAuth<T>(
  url: string,
  init: RequestInit = {},
  accessToken: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
  }: { timeoutMs?: number; retries?: number } = {},
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce<T>(url, init, accessToken, timeoutMs);
    } catch (error) {
      if (
        !(error instanceof GoogleApiError && error.retryable) ||
        attempt >= retries
      ) {
        throw error;
      }

      // Exponential backoff with jitter, which Google asks for on rate limits.
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          RETRY_BASE_DELAY_MS * 2 ** attempt * (1 + Math.random()),
        ),
      );
    }
  }
}

async function fetchOnce<T>(
  url: string,
  init: RequestInit,
  accessToken: string,
  timeoutMs: number,
): Promise<T | null> {
  const releaseRequestSlot = await acquireRequestSlot(accessToken);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      headers: buildHeaders(init.headers, accessToken),
      signal: controller.signal,
    });

    if (response.status === 401) {
      throw new AisistAuthError(
        'AUTH_INVALID_TOKEN',
        'Google access token is invalid or expired. Sign in again.',
        {
          retryable: false,
          status: 401,
        },
      );
    }

    if (response.status === 403) {
      throw await buildForbiddenError(response);
    }

    if (response.status === 429) {
      throw new GoogleApiError('GOOGLE_API_RATE_LIMITED', RATE_LIMIT_MESSAGE, {
        retryable: true,
        status: 429,
      });
    }

    if (!response.ok) {
      throw new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        `Google API request failed with status ${response.status}.`,
        {
          retryable: response.status >= 500,
          status: response.status,
        },
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof AisistAuthError || error instanceof GoogleApiError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request timed out. Retry the request.',
        {
          retryable: true,
          status: 503,
        },
      );
    }

    if (error instanceof TypeError) {
      throw new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request failed due to a network error. Retry the request.',
        {
          retryable: true,
          status: 503,
        },
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    releaseRequestSlot();
  }
}

type GoogleErrorBody = {
  error?: {
    message?: string;
    details?: Array<{ reason?: string }>;
    errors?: Array<{ reason?: string }>;
  };
};

// Google answers 403 for several unrelated problems. The three that matter here
// are a project that has not enabled the API, a rate limit, and a token that
// lacks the scope; only the last is fixed by signing in again, so telling them
// apart keeps us from sending the user round a re-auth loop that cannot help.
async function buildForbiddenError(
  response: Response,
): Promise<GoogleApiError> {
  const { reason, message } = await readErrorDetail(response);

  if (
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded' ||
    reason === 'RATE_LIMIT_EXCEEDED'
  ) {
    return new GoogleApiError('GOOGLE_API_RATE_LIMITED', RATE_LIMIT_MESSAGE, {
      retryable: true,
      status: 403,
    });
  }

  if (reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured') {
    return new GoogleApiError(
      'GOOGLE_API_SERVICE_DISABLED',
      `A Google API required for this request is not enabled for the project. Enable it in the Google Cloud console, then retry. Signing in again will not help.${message ? ` Google reported: ${message}` : ''}`,
      {
        retryable: false,
        status: 403,
      },
    );
  }

  return new GoogleApiError(
    'GOOGLE_API_INSUFFICIENT_SCOPE',
    `Google denied the request as forbidden. If this is a permissions problem, sign in again to grant calendar, tasks, and Gmail access.${message ? ` Google reported: ${message}` : ''}`,
    {
      retryable: false,
      status: 403,
    },
  );
}

async function readErrorDetail(response: Response): Promise<{
  reason?: string;
  message?: string;
}> {
  let body: GoogleErrorBody;

  try {
    body = JSON.parse(await response.text()) as GoogleErrorBody;
  } catch {
    return {};
  }

  const reason =
    body.error?.details?.find((detail) => detail.reason)?.reason ??
    body.error?.errors?.find((detail) => detail.reason)?.reason;

  return {
    reason,
    message: body.error?.message?.trim() || undefined,
  };
}

function buildHeaders(
  headersInit: HeadersInit | undefined,
  accessToken: string,
): Headers {
  const headers = new Headers(headersInit);

  headers.set('Authorization', `Bearer ${accessToken}`);

  return headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();

  if (responseText.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new GoogleApiError(
      'GOOGLE_API_REQUEST_FAILED',
      'Google API returned an invalid JSON response.',
      {
        retryable: true,
        status: 502,
      },
    );
  }
}
