import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AISIST_NAMESPACE, deriveThreadId } from '../auth.js';
import { createProxyServer, type ProxyOptions } from '../server.js';

const EMAIL = 'test@example.com';
const GOOD_TOKEN = 'good-token';
const OWN_THREAD = deriveThreadId(EMAIL);

type UpstreamRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

// Accepts GOOD_TOKEN for EMAIL; anything else is a 400 like Google's endpoint.
async function startTokeninfo(status: 'ok' | 'down' = 'ok'): Promise<string> {
  const server = http.createServer((req, res) => {
    if (status === 'down') {
      res.writeHead(500);
      res.end();
      return;
    }
    const token = new URL(req.url ?? '/', 'http://t').searchParams.get(
      'access_token',
    );
    if (token === GOOD_TOKEN) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: EMAIL }));
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    }
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

async function startUpstream(
  handler?: http.RequestListener,
): Promise<{ port: number; requests: UpstreamRequest[] }> {
  const requests: UpstreamRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  const port = await listen(server);
  return { port, requests };
}

async function startProxy(
  upstreamPort: number,
  overrides: Partial<ProxyOptions> = {},
): Promise<number> {
  return listen(
    createProxyServer({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      tokeninfoUrl: overrides.tokeninfoUrl ?? (await startTokeninfo()),
      ...overrides,
    }),
  );
}

const authed = { authorization: `Bearer ${GOOD_TOKEN}` };

describe('authentication', () => {
  it('rejects requests without a bearer token before touching the upstream', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`,
    );

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects an invalid token with 401', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`,
      { headers: { authorization: 'Bearer wrong' } },
    );

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('maps tokeninfo outages to 503', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port, {
      tokeninfoUrl: await startTokeninfo('down'),
    });

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`,
      { headers: authed },
    );

    expect(response.status).toBe(503);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('thread authorization', () => {
  it('forwards reads of the caller-owned thread', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}/state`,
      { headers: authed },
    );

    expect(response.status).toBe(200);
    expect(upstream.requests[0].url).toBe(`/threads/${OWN_THREAD}/state`);
  });

  it("rejects reads of another user's thread with 403", async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);
    const foreign = deriveThreadId('other@example.com');

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${foreign}`,
      { headers: authed },
    );

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects thread creation with a mismatched thread_id', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/threads`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: deriveThreadId('other@example.com') }),
    });

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it('injects the derived thread_id on thread creation', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    await fetch(`http://127.0.0.1:${proxyPort}/threads`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ if_exists: 'do_nothing' }),
    });

    expect(JSON.parse(upstream.requests[0].body)).toEqual({
      if_exists: 'do_nothing',
      thread_id: OWN_THREAD,
    });
  });
});

describe('run stream', () => {
  it('rewrites config.configurable.access_token to the validated token', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}/runs/stream`,
      {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({
          assistant_id: 'agent',
          config: {
            configurable: { access_token: 'smuggled', timezone: 'UTC' },
          },
        }),
      },
    );

    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.config.configurable.access_token).toBe(GOOD_TOKEN);
    expect(forwarded.config.configurable.timezone).toBe('UTC');
  });

  it('creates the config object when the client omits it', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}/runs/stream`,
      {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ assistant_id: 'agent' }),
      },
    );

    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.config.configurable.access_token).toBe(GOOD_TOKEN);
  });

  it('streams SSE chunks through without buffering', async () => {
    let releaseSecondEvent = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });

    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: first\ndata: {}\n\n');
      void gate.then(() => {
        res.write('event: second\ndata: {}\n\n');
        res.end();
      });
    });
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}/runs/stream`,
      { method: 'POST', headers: authed },
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('event: first');

    releaseSecondEvent();

    let rest = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain('event: second');
  });
});

describe('limits and errors', () => {
  it('enforces the per-user rate limit', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port, {
      rateLimit: { limit: 2, windowMs: 60_000 },
    });

    const request = () =>
      fetch(`http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`, {
        headers: authed,
      });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    expect(upstream.requests).toHaveLength(2);
  });

  it('does not forward client credentials upstream', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    await fetch(`http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`, {
      headers: { ...authed, 'x-api-key': 'client-key', cookie: 'session=abc' },
    });

    const seen = upstream.requests[0].headers;
    expect(seen['x-api-key']).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
  });

  it('rejects unknown routes without auth or upstream contact', async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/assistants`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('returns 503 when the upstream is unreachable', async () => {
    const upstream = await startUpstream();
    const deadPort = upstream.port;
    await new Promise((resolve) => servers.pop()!.close(resolve));

    const proxyPort = await startProxy(deadPort);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/${OWN_THREAD}`,
      { headers: authed },
    );

    expect(response.status).toBe(503);
  });
});

describe('namespace drift guard', () => {
  it('matches the backend thread namespace', () => {
    const backendSource = fs.readFileSync(
      path.resolve(__dirname, '../../../backend/src/utils/thread.ts'),
      'utf8',
    );
    expect(backendSource).toContain(AISIST_NAMESPACE);
  });
});
