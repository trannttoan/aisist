import http from 'node:http';

export type ProxyOptions = {
  upstreamUrl: string;
};

type Route = { method: string; pattern: RegExp };

// The four LangGraph endpoints the mobile client uses; everything else 404s.
const ROUTES: Route[] = [
  { method: 'POST', pattern: /^\/threads$/ },
  { method: 'GET', pattern: /^\/threads\/[^/]+$/ },
  { method: 'GET', pattern: /^\/threads\/[^/]+\/state$/ },
  { method: 'POST', pattern: /^\/threads\/[^/]+\/runs\/stream$/ },
];

const REQUEST_HEADERS = ['accept', 'content-type'];
const RESPONSE_HEADERS = ['content-type', 'cache-control'];

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

export function createProxyServer(options: ProxyOptions): http.Server {
  const upstream = options.upstreamUrl.replace(/\/+$/, '');

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.local');

    if (req.method === 'GET' && url.pathname === '/ok') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const matched = ROUTES.some(
      (route) =>
        route.method === req.method && route.pattern.test(url.pathname),
    );

    if (!matched) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const body = await readBody(req);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(
        `${upstream}${url.pathname}${url.search}`,
        {
          method: req.method,
          headers: buildUpstreamHeaders(req),
          body: body.length > 0 ? new Uint8Array(body) : undefined,
        },
      );
    } catch {
      sendJson(res, 503, { error: 'upstream unavailable, try again shortly' });
      return;
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }

    res.writeHead(upstreamResponse.status, responseHeaders);

    // Relay chunk by chunk — buffering here would break SSE streaming.
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }

    res.end();
  });
}
