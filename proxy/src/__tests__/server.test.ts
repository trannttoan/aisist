import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createProxyServer } from '../server.js';

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

async function startUpstream(
  handler: http.RequestListener,
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
      handler(req, res);
    });
  });
  const port = await listen(server);
  return { port, requests };
}

async function startProxy(upstreamPort: number): Promise<number> {
  return listen(
    createProxyServer({ upstreamUrl: `http://127.0.0.1:${upstreamPort}` }),
  );
}

describe('proxy passthrough', () => {
  it('answers /ok without contacting the upstream', async () => {
    const upstream = await startUpstream((_req, res) => res.end());
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/ok`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects unknown routes without contacting the upstream', async () => {
    const upstream = await startUpstream((_req, res) => res.end());
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/assistants`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('forwards thread reads and relays status and body', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"thread_id":"t1"}');
    });
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/threads/t1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread_id: 't1' });
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET',
      url: '/threads/t1',
    });
  });

  it('forwards POST bodies and content-type', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const proxyPort = await startProxy(upstream.port);

    await fetch(`http://127.0.0.1:${proxyPort}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"thread_id":"t1"}',
    });

    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/threads',
      body: '{"thread_id":"t1"}',
    });
    expect(upstream.requests[0].headers['content-type']).toBe(
      'application/json',
    );
  });

  it('does not forward client credentials upstream', async () => {
    const upstream = await startUpstream((_req, res) => res.end('{}'));
    const proxyPort = await startProxy(upstream.port);

    await fetch(`http://127.0.0.1:${proxyPort}/threads/t1`, {
      headers: {
        'x-api-key': 'client-key',
        authorization: 'Bearer token',
        cookie: 'session=abc',
      },
    });

    const seen = upstream.requests[0].headers;
    expect(seen['x-api-key']).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
  });

  it('streams SSE chunks through without buffering', async () => {
    let releaseSecondEvent = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });

    const upstream = await startUpstream((req, res) => {
      if (req.url?.endsWith('/runs/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: first\ndata: {}\n\n');
        void gate.then(() => {
          res.write('event: second\ndata: {}\n\n');
          res.end();
        });
      } else {
        res.end();
      }
    });
    const proxyPort = await startProxy(upstream.port);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/threads/t1/runs/stream`,
      { method: 'POST' },
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');

    // If the proxy buffered the whole response, this first read would hang
    // until the gate opens — but the gate only opens after the read succeeds.
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

  it('returns 503 when the upstream is unreachable', async () => {
    const upstream = await startUpstream((_req, res) => res.end());
    const deadPort = upstream.port;
    await new Promise((resolve) => servers.pop()!.close(resolve));

    const proxyPort = await startProxy(deadPort);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/threads/t1`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('upstream unavailable'),
    });
  });
});
