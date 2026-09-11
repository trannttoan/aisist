# Self-Host Migration — LangGraph Cloud → Desktop, LangSmith → Langfuse

Moves the backend off LangGraph Cloud onto a standalone LangGraph server running on the
gaming desktop (Windows 11 + WSL2, rootless Docker), reachable from the phone over
Tailscale. Tracing moves from LangSmith to the self-hosted Langfuse already running on the
desktop.

This document consolidates and supersedes:

- `aisist-full-setup.md` (repo root) — app + desktop setup template
- the app-facing parts of `gaming-desktop-server-setup.md` (repo root)
- the previous draft of this file
- steps 5–6 of [RENAME-MIGRATION.md](RENAME-MIGRATION.md)

Facts below were verified against the repo at `c15b301` and against current LangChain and
Langfuse docs (Aug 2026). Anything still uncertain is marked **verify**.
§8 was implemented in Sep 2026 (PRs #16–#19) and rewritten from design to record.

---

## 0. Where things stand

**Done:**

- Troli → Aisist rename merged (`7e3153e`, PR #11). Sign-in verified on device.
- Desktop set up per `gaming-desktop-server-setup.md` steps 1–6, with these confirmed
  specifics:
  - **Option B** distro hardening: the existing Ubuntu distro has `automount`/`interop`
    disabled — no `/mnt/c`, no Windows credential access from WSL.
  - Rootless Docker as the unprivileged `services` user, linger enabled, WSL keep-alive
    scheduled task in place (reboot + login brings everything back).
  - Langfuse self-hosted at `127.0.0.1:3000`, served on the tailnet at
    `https://<desktop>.<tailnet>.ts.net` (port 443) via `tailscale serve`.
  - Tailnet ACLs hardened: phone/Mac reach the desktop only on enumerated ports
    (currently 443, possibly 22). Mac and phone are on the tailnet.
- Steps 7+ of the desktop guide (GPU/vLLM/monitoring/training) are **not** done and are
  not needed for this migration — the backend calls Gemini via `GOOGLE_API_KEY`.

**Current app state:**

- Mobile talks directly to LangGraph Cloud. `mobile/src/services/langgraph.ts` hand-rolls
  the HTTP calls (no `@langchain/langgraph-sdk` anywhere in the workspace) against four
  endpoints: `POST /threads`, `GET /threads/{id}`, `GET /threads/{id}/state`,
  `POST /threads/{id}/runs/stream` (SSE).
- Every call carries `x-api-key` (`mobile/src/services/langgraph.ts:335`) holding a
  LangSmith personal token from `EXPO_PUBLIC_LANGGRAPH_API_KEY`. The client refuses to
  start without a non-empty value (`langgraph.ts:93`).
- The Google access token travels in the run body as `config.configurable.access_token`
  and is read back by `backend/src/utils/tool-config.ts`.
- Auth runs inside the graph: `preprocessNode` (`backend/src/agent.ts`) calls
  `validateGoogleToken` (Google tokeninfo) and `verifyThreadAuthorization`. Thread IDs are
  `uuidv5(email, AISIST_NAMESPACE)`, with the namespace duplicated in
  `backend/src/utils/thread.ts` and `mobile/src/utils/thread.ts`.
- `backend/langgraph.json` already exists: graph `agent` → `./src/agent.ts:graph`,
  `node_version` 22, `dependencies: ["."]`, `env: ".env"` (dev only).
- CLI is `@langchain/langgraph-cli@^1.2.5` with `dev`/`build`/`up`/`dockerfile` wired as
  pnpm scripts (`langgraph:build` etc.).

## 1. Target architecture

**Current phase — Tailscale direct, no proxy:**

```
iPhone (Expo dev build, Tailscale VPN on)
   │  https://<desktop>.<tailnet>.ts.net:8445
   ▼
Windows host ── tailscale serve (TLS, tailnet-only) ──▶ localhost:8123 (WSL2 relay)
   ▼
Ubuntu WSL2, rootless Docker (services user)
   ├─ aisist api      127.0.0.1:8123 → container :8000   (langgraph standalone image)
   ├─ postgres:16     (threads, checkpoints — internal network only)
   ├─ redis:7         (run queue — internal network only)
   └─ langfuse stack  127.0.0.1:3000 (already running)
        └── shared docker network: agents-shared
```

Port plan on the tailnet: 443 = Langfuse (taken), **8445 = aisist API**. 8443/8444 stay
reserved for vLLM/Grafana if desktop-guide steps 7+ ever happen.

**Public phase (implemented — see §8):** an OCI VPS on the tailnet runs the auth proxy,
published to the internet via Tailscale Funnel at
`https://aisist-vps.<tailnet>.ts.net`. The stack above is unchanged; the tailnet-direct
`:8445` URL remains the development path.

## 2. Design decisions (and why)

**Standalone container, not a rewrite.** `langgraph build` wraps the graph in LangChain's
official API server image, exposing the same HTTP API the mobile client already speaks
(`/threads`, `/runs/stream` SSE, checkpoints), backed by Postgres + Redis you provide. The
mobile client needs **no code changes** this phase — only env values.

**Auth this phase = network layer + existing graph validation.** Custom auth is not
available on Self-Hosted Lite ([langgraph#5390](https://github.com/langchain-ai/langgraph/issues/5390));
the `x-api-key` header is ignored. Known consequence (was `docs/plans/phase-1.md:68-74`):
the three non-run endpoints have no user-level auth, and thread IDs are derivable from an
email. That is acceptable **now** because the only devices that can reach port 8445 at all
are your own (tailnet ACLs), and it stops being acceptable the moment anything public
fronts this — which is why the VPS phase requires the proxy in §8 before launch. Do not
shortcut the VPS phase with a shared key baked into the app; that recreates the
extractable-token problem this migration closes.

**LangSmith stays as a license, not a tracer.** The standalone server authenticates at
startup with `LANGSMITH_API_KEY` and needs egress to `https://beacon.langchain.com` for
license verification ([docs](https://docs.langchain.com/langsmith/deploy-standalone-server)).
`LANGGRAPH_CLOUD_LICENSE_KEY` is the enterprise variant — only reach for it if startup
demands it (confirmed at first boot: the server logs `running in lite mode with LangSmith API
key` and starts — that warning is the healthy state, not a problem; a node-execution
cap applies on the free plan). "License verification failed" in container logs is
always env config, never code. The key now lives server-side, never in a mobile bundle.

**Langfuse via the v4 JS SDK.** The backend is on `@langchain/core` 1.x; LangChain v1
support landed in `@langfuse/langchain` **≥ 4.3.0**
([changelog](https://langfuse.com/changelog/2025-10-26-langchain-v1-support)). The old
`langfuse-langchain` v3 package is the wrong choice here (v1 compat unverified, and it
reads `LANGFUSE_BASEURL` — no underscore — a classic silent-no-traces trap). v4 is
OpenTelemetry-based: it needs a `LangfuseSpanProcessor` registered in a `NodeSDK` at
module load, plus the `CallbackHandler` bound to the graph at compile time (the server
invokes the graph itself, so per-call callbacks aren't possible). Tracing is fail-open:
Langfuse down ⇒ spans dropped, runs unaffected.

## 3. Phase 1 — Backend changes (on the Mac, in this repo)

### 3.1 Dependencies

```bash
pnpm --filter @aisist/backend add @langfuse/langchain @langfuse/otel @opentelemetry/sdk-node
```

**Security floor:** `@langchain/langgraph` must be ≥ 1.4.12 and
`@langchain/langgraph-checkpoint` ≥ 1.1.4 —
[GHSA-j87f-x5h5-gr75](https://github.com/langchain-ai/langgraphjs/security/advisories/GHSA-j87f-x5h5-gr75)
(insecure deserialization in `JsonPlusSerializer`, CVSS 7.7) allows arbitrary code
execution when a checkpoint containing attacker-crafted structured data (e.g.
`additional_kwargs`) is restored. Auth is not a mitigation — an authorized caller can
plant the payload — so never downgrade below these versions. The langgraph-cli 1.4.x
line ships the matching patched dev-server harness.

### 3.2 `backend/src/agent.ts`

Two additions (shape below — confirm exact API against the Langfuse v4 docs when
implementing):

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { CallbackHandler } from '@langfuse/langchain';

// module scope — runs once per server worker
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }).start();
}

export const graph = workflow.compile().withConfig({
  callbacks: [new CallbackHandler()],
});
```

Today the last line is `export const graph = workflow.compile();`. Without keys set, the
handler's spans hit a no-op tracer — local dev without Langfuse still works. Do **not**
wire a checkpointer into the compiled graph; the server injects its own (that's what its
Postgres is for).

The handler/processor read `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
`LANGFUSE_BASE_URL`, and `LANGFUSE_TRACING_ENVIRONMENT` from env. Per-user/session
attribution in traces (userId, sessionId from run metadata) is a later upgrade — get
plain traces flowing first.

### 3.3 Env files

`backend/.env.example` — remove `LANGSMITH_ENDPOINT` and `LANGSMITH_PROJECT`, flip
tracing off, add Langfuse:

```bash
GOOGLE_API_KEY=
LANGSMITH_API_KEY=            # standalone-server license only — tracing stays off
LANGSMITH_TRACING=false
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=            # dev: http://localhost:3000 tunnel or leave unset
LANGFUSE_TRACING_ENVIRONMENT=dev
```

`LANGSMITH_TRACING=false` matters: the built-in LangChain tracer is env-driven with no
code references, so this is the whole off-switch. Mirror the same shape in `backend/.env`
(gitignored).

### 3.4 Keep `.env` out of the image

`langgraph.json` has `dependencies: ["."]`, so the build context is all of `backend/` —
including `backend/.env` if you build where it exists. Add `backend/.dockerignore`:

```
.env
node_modules
```

(The desktop builds from a fresh clone with no `.env`, so this is a backstop, but a cheap
one.)

### 3.5 Local dev loop

```bash
pnpm --filter @aisist/backend dev        # langgraphjs dev, in-memory persistence
curl -s http://localhost:2024/ok
```

Optionally point the phone dev client at `http://<mac-ip>:2024` to smoke-test on-device
before the desktop exists. Then `pnpm -r run typecheck && pnpm -r run test` — the
`withConfig` change should not disturb the existing 121 backend / 100 mobile tests, but
confirm.

## 4. Phase 2 — Desktop deployment (Ubuntu WSL, as `services`)

Everything below runs as the `services` user unless marked **[Windows]**. Enter with
`sudo -iu services` (`-i` matters: full login shell, correct `$HOME`).

### 4.1 Toolchain + repo

```bash
# SSH deploy key — Option B distro has no Windows credential access
ssh-keygen -t ed25519 -C "desktop-services"
cat ~/.ssh/id_ed25519.pub        # add as read-only deploy key on the GitHub repo

# Node 22 + pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
corepack enable && corepack prepare pnpm@latest --activate

git clone git@github.com:<you>/aisist.git ~/apps/aisist
cd ~/apps/aisist && pnpm install
```

Clone into the Linux filesystem (`~/apps`) — on this distro `/mnt/c` doesn't exist
anyway.

### 4.2 Log caps for the rootless daemon

```bash
mkdir -p ~/.config/docker
cat > ~/.config/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl --user restart docker    # briefly bounces Langfuse; it self-heals
```

### 4.3 Build the image

```bash
cd ~/apps/aisist/backend
npx @langchain/langgraph-cli build -t aisist-backend:latest
```

The CLI pulls the latest `langgraphjs-api` base image by default — do **not** pass
`--no-pull`: the server runtime inside the base image has its own copy of the checkpoint
serializer and must also carry the GHSA-j87f-x5h5-gr75 patch (§3.1).

If the container later fails on DB config, inspect what the generated image expects:
`npx @langchain/langgraph-cli dockerfile -` from `backend/`.

### 4.4 Shared network → Langfuse

```bash
docker network create agents-shared
```

In `~/langfuse/docker-compose.yml`, add at top level:

```yaml
networks:
  agents-shared:
    external: true
```

and under the web service (name it exactly as `docker compose ps` shows — usually
`langfuse-web`):

```yaml
networks:
  - default
  - agents-shared
```

Apply with `cd ~/langfuse && docker compose up -d`. This is why
`LANGFUSE_BASE_URL=http://langfuse-web:3000` resolves from inside the aisist container,
sidestepping rootless Docker's host-loopback limitations.

### 4.5 Deploy config

Deployment lives outside the repo checkout so `git pull` never touches it.

`~/apps/aisist-deploy/docker-compose.yml`:

```yaml
name: aisist
networks:
  agents-shared:
    external: true
services:
  api:
    image: aisist-backend:latest
    restart: always
    ports:
      - '127.0.0.1:8123:8000'
    env_file: .env
    environment:
      REDIS_URI: redis://redis:6379
      DATABASE_URI: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/aisist?sslmode=disable
      POSTGRES_URI: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/aisist?sslmode=disable
    networks:
      - default
      - agents-shared
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
  postgres:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_DB: aisist
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      retries: 10
  redis:
    image: redis:7
    restart: always
volumes:
  pgdata:
```

`DATABASE_URI` is the documented variable; `POSTGRES_URI` is set too because server
versions have differed on which they read — the extra one is ignored.

`~/apps/aisist-deploy/.env`, then `chmod 600 .env`:

```bash
POSTGRES_PASSWORD=<openssl rand -hex 24>
LANGSMITH_API_KEY=<langsmith key>       # license only
LANGSMITH_TRACING=false                 # keep traces out of LangSmith cloud
GOOGLE_API_KEY=<gemini key>
LANGFUSE_PUBLIC_KEY=<pk from self-hosted Langfuse project "aisist">
LANGFUSE_SECRET_KEY=<sk from same>
LANGFUSE_BASE_URL=http://langfuse-web:3000
LANGFUSE_TRACING_ENVIRONMENT=prod
```

Create the `aisist` project in the Langfuse UI first and copy its keys.

### 4.6 First boot + local verification

```bash
cd ~/apps/aisist-deploy
docker compose up -d
docker compose logs -f api          # wait for migrations + license check, then Ctrl+C
curl -s http://localhost:8123/ok    # → {"ok":true}

# Langfuse reachability from inside the container (no wget/curl in the image)
docker compose exec api node -e \
  "fetch('http://langfuse-web:3000/api/public/health').then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.error('ERR',e.cause?.code||e.message))"
```

Then drive a real run with the repo's verify script (it reads `LANGGRAPH_API_URL` /
`LANGGRAPH_API_KEY`; Lite ignores the key but the script requires a value):

```bash
cd ~/apps/aisist
LANGGRAPH_API_URL=http://localhost:8123 \
LANGGRAPH_API_KEY=unused \
GOOGLE_ACCESS_TOKEN=<token> GOOGLE_ACCOUNT_EMAIL=<test-email> \
pnpm --filter @aisist/backend run verify:cloud
```

After it passes, check both tracing outcomes: the run appears in Langfuse
(`environment=prod`), and nothing new appears in the LangSmith cloud dashboard.

### 4.7 Publish over Tailscale — [Windows]

443 stays with Langfuse. Elevated PowerShell:

```powershell
tailscale serve --bg --https=8445 http://localhost:8123
```

(If the syntax complains, check `tailscale serve --help` — it changed between versions.)

**ACLs:** the tailnet ACLs enumerate ports, so add 8445 to what phone/Mac may reach on
the desktop — otherwise the next test fails and looks like a server bug.

Test from the phone on cellular with Tailscale on:
`https://<desktop>.<tailnet>.ts.net:8445/ok` → `{"ok":true}`. Then confirm it does NOT
load from a non-tailnet device.

## 5. Phase 3 — Point the app at it

`mobile/.env` (and matching `.env.example` comments):

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<unchanged>
EXPO_PUBLIC_LANGGRAPH_API_URL=https://<desktop>.<tailnet>.ts.net:8445
EXPO_PUBLIC_LANGGRAPH_API_KEY=unused    # client requires non-empty; Lite ignores it
EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID=agent
```

No mobile code changes: the client keeps sending `x-api-key` (harmlessly ignored), the
SSE path (`mobile/src/services/sse.ts`) is talking to the same server API, and the
existing tests asserting the header stay valid. Dropping the header entirely happens in
the VPS phase.

Rebuild the Expo dev build, then smoke test: send a message → response streams; kill and
reopen the app → thread rehydrates from the server.

> **Superseded (Sep 2026):** the client now sends `Authorization: Bearer <google token>`
> on every request and `EXPO_PUBLIC_LANGGRAPH_API_KEY` no longer exists (PR #18) — see
> §8.3. The tailnet-direct URL still works as a dev path (runs still carry the body
> `access_token`, so the graph's own validation suffices without the proxy).

## 6. Phase 4 — Acceptance checklist

- [x] `docker compose ps` in `~/apps/aisist-deploy`: three services running
- [x] `curl localhost:8123/ok` inside Ubuntu → ok
- [x] `https://<desktop>.<tailnet>.ts.net:8445/ok` from phone on cellular → ok
- [x] `verify:cloud` passes against `localhost:8123` (and optionally the ts.net URL from the Mac)
- [x] Mobile smoke test: stream + rehydrate
- [x] A phone-initiated run appears in Langfuse with `environment=prod`
- [x] Nothing new appears in LangSmith cloud
- [x] **Reboot test:** reboot Windows, log in (manual login is by design), touch nothing
      else; after ~2 minutes the `/ok` URL answers from the phone on cellular. Linger +
      the scheduled task + `restart: always` should need zero further intervention.

## 7. Phase 5 — Decommission and cleanup

Only after the checklist passes:

1. Delete the LangGraph Cloud deployment (`https://troli-<hash>.us.langgraph.app`).
2. Revoke the LangSmith personal token that shipped in the old mobile env; if it's the
   same key now used as the server license, rotate it instead and update the deploy
   `.env`. Ordinary hygiene, not incident response — the old token was never distributed
   (no TestFlight; only the dev phone and local Xcode build products).
3. Clear stale build products on the Mac:
   ```bash
   rm -rf ~/Library/Developer/Xcode/DerivedData/Troli-* ~/Library/Developer/Xcode/DerivedData/Aisist-*
   ```

## 8. Phase 6 — OCI VPS front door + auth proxy (implemented)

Live since Sep 2026 (PRs [#16](https://github.com/trannttoan/aisist/pull/16)
[#17](https://github.com/trannttoan/aisist/pull/17)
[#18](https://github.com/trannttoan/aisist/pull/18)
[#19](https://github.com/trannttoan/aisist/pull/19)). Public URL:
**`https://aisist-vps.<tailnet>.ts.net`**.

```
internet ── Tailscale Funnel (TLS, Let's Encrypt) ──▶ aisist-vps
              (VPS has ZERO open inbound ports;        OCI A1.Flex 2 OCPU/12 GB, Ubuntu 24.04
               funnel traffic arrives via relays)      systemd: aisist-proxy → node :8080
                                                          │ tailnet, ACL: desktop:8445 only
                                                          ▼
                                                   desktop :8445 (unchanged §4 stack)
```

### 8.1 Resolved design decisions

- **No domain, no Caddy — Tailscale Funnel.** Funnel gives a public URL with a real
  Let's Encrypt cert and delivers traffic via Tailscale's relays, so the OCI security
  list has **no TCP ingress at all** (the default port-22 rule was removed once
  Tailscale SSH was proven; note `evolve-pilot` shares that security list). A custom
  domain later only swaps the publish step — the proxy is untouched.
- **Proxy = third workspace package (`proxy/`).** Plain Node 22 `http`, no framework,
  `uuid` as the only runtime dep. It **duplicates** the ~70-line tokeninfo validation
  and `AISIST_NAMESPACE` (the pattern `mobile/` already uses) instead of refactoring
  `backend/src/utils/auth.ts` — a drift-guard test reads the backend source and fails if
  the namespace diverges. The graph's own validation stays intact as the second layer.
- **Degradation = 503.** Short upstream header-timeout (cleared once headers arrive, so
  it can never cut a long SSE body), `{"detail": "upstream unavailable…"}` when the
  desktop is down. No cloud-LLM fallback.

### 8.2 What the proxy enforces (`proxy/src/server.ts`)

- Only the four client endpoints exist (+ its own `/ok`); everything else 404s without
  touching the upstream.
- Bearer token required on all four, validated against Google tokeninfo with the same
  semantics as the graph (401 invalid, 503 tokeninfo outage, email lower/trimmed).
- Thread ownership: path `{id}` must equal `uuidv5(email, AISIST_NAMESPACE)` → 403.
  `POST /threads` rejects a mismatched `thread_id` and injects the derived one.
- `POST /threads/{id}/runs/stream`: `config.configurable.access_token` is **rewritten**
  to the validated token — a smuggled second token cannot reach Google APIs.
- Per-user fixed-window rate limit (60/min default, constructor-configurable).
- Header allowlists both directions — client credentials (`x-api-key`, `Authorization`,
  cookies) never reach the LangGraph server.
- SSE relays chunk-by-chunk; a gated-upstream test pins the no-buffering behavior.

### 8.3 Mobile changes (PR #18)

`Authorization: Bearer <google access token>` on every request, threaded explicitly
through the service from the auth store's `getValidToken()`. `x-api-key` and
`EXPO_PUBLIC_LANGGRAPH_API_KEY` are gone from code, env files, and config validation —
the app bundle contains no shared credential. Runs still send the body `access_token`
(the proxy overwrites it), which keeps the tailnet-direct dev path working.

```bash
# mobile/.env — public build
EXPO_PUBLIC_LANGGRAPH_API_URL=https://aisist-vps.<tailnet>.ts.net
# dev alternative: https://<desktop>.<tailnet>.ts.net:8445 (tailnet only)
```

### 8.4 VPS deployment

See `proxy/deploy/README.md` (one-time setup + update command). Summary: Node 22 from
NodeSource, public-repo clone under `~/apps/aisist`, `pnpm install --filter
@aisist/proxy` + `tsc` build, systemd unit `proxy/deploy/aisist-proxy.service` with env
in `/etc/aisist-proxy.env` (upstream URL + port, never in git), then
`sudo tailscale funnel --bg 8080`. Funnel config and the unit both survive reboots
(verified).

### 8.5 Tailnet policy (final state)

```jsonc
"acls": [
    {"action": "accept", "src": ["tag:client"], "dst": ["tag:desktop:22,443,8443,8444,8445"]},
    {"action": "accept", "src": ["tag:vps"],    "dst": ["tag:desktop:8445"]},   // nothing else
    {"action": "accept", "src": ["tag:client"], "dst": ["tag:vps:22,443"]},
],
"ssh": [
    {"action": "accept", "src": ["tag:client"], "dst": ["tag:desktop", "tag:vps"],
     "users": ["autogroup:nonroot", "root"]},
],
"nodeAttrs": [
    {"target": ["tag:vps"], "attr": ["funnel"]},
],
```

`443` in the client→vps rule matters for a non-obvious reason: on tailnet devices,
MagicDNS resolves the funnel hostname to the tailnet IP, bypassing the public ingress —
without 443 there, the app looks broken on your own devices whenever Tailscale is on.
Granting it widens nothing (the same port is already public via Funnel) and skips the
relay round-trip.

### 8.6 Verification record

- 15 proxy unit tests (auth paths, ownership, token rewrite, rate limit, credential
  stripping, SSE no-buffering, namespace drift guard).
- Live e2e through the proxy against the real desktop stack with a real OAuth token —
  including a decoy body `access_token` that the run's success proved was replaced.
- Public-ingress probes with DNS pinned past MagicDNS: `/ok` 200 under a Let's Encrypt
  cert, bogus token 401 via real tokeninfo, unknown route 404.
- VPS reboot: systemd unit, proxy, and Funnel self-restored.
- [ ] **Remaining:** release-build cellular smoke — `npx expo run:ios --device
  --configuration Release` with the funnel URL baked in, Tailscale off, stream +
      rehydrate. (A dev build cannot test cellular: it loads JS from Metro on the Mac.)

## 9. Collateral to update alongside

- **`docs/DEPLOY.md`** — documents the LangGraph Cloud rollout; rewrite for this path or
  retire it in favor of this doc's §4.
- **`docs/TRD.md`** — architecture and auth-model sections change.
- **`docs/plans/phase-1.md:68-74`** — record the shared-key exposure as **closed**: no
  shared key exists in the bundle, and the proxy (§8) enforces per-user auth on every
  endpoint. Still to be written into that file.
- **`backend/scripts/verify-langgraph-cloud.mjs`** — works as-is against the self-hosted
  server (§4.6); consider renaming `verify:cloud` later, not load-bearing.
- **Tests** — updated with PR #18: the mobile suite now asserts the Bearer header;
  the proxy package carries its own 15-test suite.
- Root-level `aisist-full-setup.md` and `gaming-desktop-server-setup.md` — the app-facing
  content now lives here; keep the desktop guide for infra reference, delete or archive
  the full-setup file.

## 10. Troubleshooting

| Symptom                                        | Likely cause / fix                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container exits: "License verification failed" | `LANGSMITH_API_KEY` missing/invalid in deploy `.env`, or no egress to beacon.langchain.com — never a code problem                                                                                               |
| api crash-loops on DB errors                   | URI var mismatch — both `DATABASE_URI` and `POSTGRES_URI` are set in §4.5; if still failing, inspect the generated Dockerfile (§4.3)                                                                            |
| Runs work, no traces in Langfuse               | Keys/`LANGFUSE_BASE_URL` unset in deploy `.env`; OTel processor not initialized (§3.2); or the v3-package `LANGFUSE_BASEURL` trap if the wrong SDK got installed. Then check the §4.6 in-container health probe |
| Traces appear in LangSmith cloud               | `LANGSMITH_TRACING=false` missing from deploy `.env`                                                                                                                                                            |
| Unreachable from phone, fine on desktop        | Phone VPN off, ACL missing 8445, or serve not persisted (`--bg`)                                                                                                                                                |
| `localhost:8123` dead, containers running      | WSL localhost relay went stale — `wsl --shutdown` from PowerShell, reopen Ubuntu, `docker compose up -d`                                                                                                        |
| Unreachable after reboot                       | Not logged in yet (manual login is by design), or the keep-alive scheduled task didn't fire — check Task Scheduler history                                                                                      |
| Build/install fails weirdly as `services`      | Wrong `$HOME` — enter with `sudo -iu services`; nvm must be installed for that user                                                                                                                             |
| Everything slow                                | Repo not under `~/apps` on the Linux filesystem                                                                                                                                                                 |
| Funnel URL dead from your own devices          | MagicDNS resolves it to the tailnet IP; the client→vps ACL rule needs `443` (§8.5) — or turn Tailscale off on that device                                                                                       |
| Funnel URL not resolving publicly              | First-enable DNS + cert provisioning takes ~10 min; a reboot mid-provisioning restarts the clock                                                                                                                |
| App dead on cellular, fine on wifi             | Dev build — it loads JS from Metro on the Mac; use `--configuration Release`                                                                                                                                    |
| 429 from the proxy                             | Per-user rate limit (60/min default) — adjust the `rateLimit` option in `proxy/src/main.ts`                                                                                                                     |

## 11. Maintenance

- **Deploy a change:** `cd ~/apps/aisist && git pull && pnpm install && cd backend &&
npx @langchain/langgraph-cli build -t aisist-backend:latest && cd ~/apps/aisist-deploy
&& docker compose up -d api`
- **Backups** (once threads stop being test data):
  `docker compose exec postgres pg_dump -U postgres aisist | gzip > backup-$(date +%F).sql.gz`
- **Monthly:** `sudo apt update && sudo apt upgrade`; `docker compose pull && docker
compose up -d` per compose dir; `wsl --update` from PowerShell; Windows reboot on your
  schedule after Patch Tuesday.
- **Disk:** `docker system prune` after a few image rebuilds.
- **VPS update:** `cd ~/apps/aisist && git pull && pnpm install --filter @aisist/proxy
&& pnpm --filter @aisist/proxy run build && sudo systemctl restart aisist-proxy`; OS:
  `sudo apt update && sudo apt upgrade` monthly.
- **Next app on the box:** own repo under `~/apps/<app>`, own deploy dir + postgres, next
  host port (8124…), join `agents-shared` if it traces, `tailscale serve --bg
--https=<8446…>`, ACL update, own Langfuse project.
