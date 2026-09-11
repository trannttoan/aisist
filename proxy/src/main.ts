import { createProxyServer } from './server.js';

const upstreamUrl = process.env.LANGGRAPH_UPSTREAM_URL;

if (!upstreamUrl) {
  throw new Error('LANGGRAPH_UPSTREAM_URL is required');
}

const port = Number(process.env.PORT ?? 8080);

createProxyServer({ upstreamUrl }).listen(port, () => {
  console.log(`aisist proxy listening on :${port} -> ${upstreamUrl}`);
});
