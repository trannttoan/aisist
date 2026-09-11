import http from 'node:http';

import {
  GOOGLE_TOKENINFO_URL,
  ProxyAuthError,
  deriveThreadId,
  validateGoogleAccessToken,
} from './auth.js';

export type ProxyOptions = {
  upstreamUrl: string;
  tokeninfoUrl?: string;
  upstreamTimeoutMs?: number;
  rateLimit?: { limit: number; windowMs: number };
};

type RouteKind = 'create-thread' | 'read-thread' | 'run-stream';

type Match = { kind: RouteKind; threadId: string | null };

const REQUEST_HEADERS = ['accept', 'content-type'];
const RESPONSE_HEADERS = ['content-type', 'cache-control'];
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

function matchRoute(method: string, pathname: string): Match | null {
  if (method === 'POST' && pathname === '/threads') {
    return { kind: 'create-thread', threadId: null };
  }
  const read = pathname.match(/^\/threads\/([^/]+)(\/state)?$/);
  if (method === 'GET' && read) {
    return { kind: 'read-thread', threadId: read[1] };
  }
  const run = pathname.match(/^\/threads\/([^/]+)\/runs\/stream$/);
  if (method === 'POST' && run) {
    return { kind: 'run-stream', threadId: run[1] };
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, payload: object) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function getBearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization;
  const match =
    typeof header === 'string' ? header.match(/^Bearer (.+)$/i) : null;
  if (!match) {
    throw new ProxyAuthError(
      401,
      'Missing Google access token. Sign in again.',
    );
  }
  return match[1];
}

function buildUpstreamHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  return headers;
}

// Rewrites the request body so the only credential and thread identity the
// upstream ever sees are the ones the proxy just validated.
function rewriteBody(
  kind: RouteKind,
  raw: Buffer,
  expectedThreadId: string,
  accessToken: string,
): Buffer {
  if (kind === 'read-thread') {
    return raw;
  }

  let body: Record<string, unknown>;
  try {
    body = raw.length > 0 ? JSON.parse(raw.toString()) : {};
  } catch {
    throw new ProxyAuthError(400, 'Request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProxyAuthError(400, 'Request body must be a JSON object.');
  }

  if (kind === 'create-thread') {
    const requested = body.thread_id;
    if (requested !== undefined && requested !== expectedThreadId) {
      throw new ProxyAuthError(
        403,
        'Thread ID does not match the authenticated user.',
      );
    }
    body.thread_id = expectedThreadId;
  }

  if (kind === 'run-stream') {
    const config =
      typeof body.config === 'object' && body.config !== null
        ? (body.config as Record<string, unknown>)
        : {};
    const configurable =
      typeof config.configurable === 'object' && config.configurable !== null
        ? (config.configurable as Record<string, unknown>)
        : {};
    configurable.access_token = accessToken;
    config.configurable = configurable;
    body.config = config;
  }

  return Buffer.from(JSON.stringify(body));
}

function createRateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const upstream = options.upstreamUrl.replace(/\/+$/, '');
  const tokeninfoUrl = options.tokeninfoUrl ?? GOOGLE_TOKENINFO_URL;
  const upstreamTimeoutMs =
    options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const { limit, windowMs } = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const allowRequest = createRateLimiter(limit, windowMs);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.local');

    if (req.method === 'GET' && url.pathname === '/ok') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const match = matchRoute(req.method ?? '', url.pathname);
    if (!match) {
      sendJson(res, 404, { detail: 'not found' });
      return;
    }

    let upstreamBody: Buffer;
    let expectedThreadId: string;
    try {
      const token = getBearerToken(req);
      const { email } = await validateGoogleAccessToken(token, tokeninfoUrl);

      if (!allowRequest(email)) {
        sendJson(res, 429, { detail: 'Too many requests. Retry shortly.' });
        return;
      }

      expectedThreadId = deriveThreadId(email);
      if (match.threadId !== null && match.threadId !== expectedThreadId) {
        throw new ProxyAuthError(
          403,
          'Thread ID does not match the authenticated user.',
        );
      }

      upstreamBody = rewriteBody(
        match.kind,
        await readBody(req),
        expectedThreadId,
        token,
      );
    } catch (error) {
      if (error instanceof ProxyAuthError) {
        sendJson(res, error.status, { detail: error.message });
        return;
      }
      throw error;
    }

    let upstreamResponse: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      upstreamResponse = await fetch(
        `${upstream}${url.pathname}${url.search}`,
        {
          method: req.method,
          headers: buildUpstreamHeaders(req),
          body:
            upstreamBody.length > 0 ? new Uint8Array(upstreamBody) : undefined,
          signal: controller.signal,
        },
      );
    } catch {
      sendJson(res, 503, { detail: 'upstream unavailable, try again shortly' });
      return;
    } finally {
      // Cleared once headers arrive — the timeout must not cut off a long
      // SSE body, only a dead upstream.
      clearTimeout(timer);
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }

    res.writeHead(upstreamResponse.status, responseHeaders);

    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }

    res.end();
  });
}
