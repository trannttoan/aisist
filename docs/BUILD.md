# Build Plan — Aisist v1.0

**Companion docs:** [PRD](PRD.md) | [TRD](TRD.md)

---

## Phase 0 — Project Scaffolding

Set up both projects with tooling and infrastructure. No features yet.

- **Mobile:** Init Expo managed project (TypeScript). Install core deps: `expo-auth-session`, `expo-secure-store`, `expo-crypto`, `zustand`, `expo-localization`.
- **Backend:** Init LangGraph.js project (TypeScript). Install deps: `@langchain/langgraph`, `@langchain/core`, `@langchain/google-genai`, `@langgraphjs/toolkit`, `zod`. Configure `langgraph.json` for LangGraph Cloud deployment. The LLM provider is swappable via LangChain's `BaseChatModel` interface — install `@langchain/openai` or `@langchain/anthropic` as alternatives without refactoring.
- **Google Cloud:** Create project, enable Calendar/Tasks/Gmail APIs, configure OAuth consent screen (external, Testing mode, stays there permanently since the app is never published), create iOS OAuth client ID.
- **Observability:** Set up LangSmith project (`aisist-v1`), wire `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` env vars.

---

## Phase 1 — Walking Skeleton

One thin path end-to-end: sign in → send message → agent responds → see it stream in chat. Proves the entire architecture works before adding breadth.

- **Auth:** Google OAuth with PKCE via `expo-auth-session`. Token storage in `expo-secure-store`. Silent refresh with 5-minute buffer and promise-based mutex.
- **Thread bootstrap:** On first login, client creates a thread via `POST /threads` using the deterministic ID `aisist-{sha256(email)}`. On subsequent launches, client hydrates the chat by fetching thread state via `GET /threads/{thread_id}` and rendering existing messages before the user sends anything. Client persists the thread ID locally alongside auth tokens.
- **Chat UI:** Minimal chat screen — flat message list (user right, agent left), text input bar with send button, SSE streaming of agent tokens, typing indicator.
- **Backend:** Bare agent graph with system prompt (no tools). Accept messages via `POST /threads/{id}/runs/stream`, return SSE stream. Thread ID derived from `aisist-{sha256(email)}`.
- **Conversation model:** Timestamp all messages at creation time. Implement 7-day message window filter + 200-message hard cap as a preprocessing node in the graph. This validates the real conversation model from day one, even before tools generate meaningful history.
- **Wiring:** Client sends Google access token + device timezone with each request. Backend validates token via Google tokeninfo endpoint and checks thread authorization.
- **Deploy:** First LangGraph Cloud deployment. Confirm mobile → backend → LLM → SSE → mobile round-trip works on a real device.
- **Tests:** Auth token lifecycle (storage, silent refresh, mutex). SSE stream parsing and incremental message rendering.

---

## Phase 2 — Calendar

Full calendar CRUD. Introduces the HITL interrupt/resume flow.

- **Read tools:** `list_calendar_events`, `get_calendar_event`. Wire up shared `fetchWithAuth` helper. Confirm the agent can answer "what's on my calendar tomorrow?"
- **Create tool:** `create_calendar_event`. Agent creates directly (no approval). Supports timed events, all-day events (`start.date`/`end.date`), and optional attendee emails.
- **HITL plumbing:** Implement `interrupt()` in backend write tools. Approval card component in client (inline in chat, Approve/Reject buttons). Resume via `POST /threads/{id}/runs/stream` with `command: { resume: "approve"|"reject" }`. Post-stream interrupt detection: after `streamRun()` completes (or on app reopen), check thread status and extract interrupt payload from thread state. On app reopen, check thread state for `interrupted` status and re-render any pending approval card.
- **Write tools:** `update_calendar_event` (with `recurringEventScope`: single/all; `thisAndFollowing` deferred — requires split-series flow), `delete_calendar_event`. Both behind HITL approval.
- **Tests:** `fetchWithAuth` helper, tool unit tests (mocked API responses), HITL interrupt/resume cycle with approve/reject.

---

## Phase 3 — Tasks

Same pattern as calendar. Faster since HITL plumbing already exists.

- **OAuth scope:** Add `https://www.googleapis.com/auth/tasks` to the requested scopes. Existing sessions re-auth automatically via the Phase 2 scope-mismatch detection; update the "calendar access" messaging to also cover tasks.
- **Read tools:** `list_task_lists`, `list_tasks`, `get_task`.
- **Create tool:** `create_task`. The system prompt rule to ask which list when the user doesn't specify one already shipped in Phase 1 — verify the behavior, no prompt change needed.
- **Write tools:** `update_task`, `delete_task`. Behind HITL approval, except status-only updates (mark complete/incomplete via `status`), which execute directly — completion is reversible. Add the exception to the system prompt approval rule.
- **Tests:** Task tool unit tests (mocked API responses).

---

## Phase 4 — Gmail

Reads first, then inbox management. Same HITL plumbing as calendar and tasks. Eight tools; no sending, no spam, no star, no thread search.

- **OAuth scope:** Add `https://www.googleapis.com/auth/gmail.modify` to `GOOGLE_SCOPES` in the mobile app. Scope-mismatch detection forces re-auth; update the "calendar and tasks access" messaging to cover Gmail.
- **Read tools:** `search_gmail`, `get_gmail_message`, `get_gmail_thread`, `list_gmail_labels`.
- **Message decoding:** Base64url decode message bodies, extract text/plain or text/html parts for agent summarization. Truncate long bodies so a thread cannot flood the model context.
- **Write tools:** `modify_gmail_labels` (archive, custom labels, read state via `batchModify`; `SPAM` and `STARRED` rejected at the schema), `trash_gmail_messages`, `create_gmail_label`, `create_gmail_draft`. Behind HITL except read/unread-only label changes, label creation, and draft creation. Batch tools cap `messageIds` at 50 per call.
- **Approval card:** Extend the interrupt payload and card to render a message list (count, sender, subject) for bulk actions.
- **System prompt tuning:** Agent translates natural language queries into Gmail search syntax internally, responds conversationally, and treats email content as data rather than instructions.
- **Tests:** Gmail tool unit tests (mocked API responses, base64 decoding, RFC 2822 encoding for drafts), HITL cycle for a bulk archive.

---

## Phase 5 — Polish and Hardening

- **Settings screen:** Gear icon in header. Shows connected Google email. Sign-out button (clears tokens from SecureStore, navigates to sign-in screen, retains conversation history).
- **Error states:** OAuth failure/cancel (stay on sign-in with retry), revoked access (full-screen re-auth prompt), network errors (error message in chat), API rate limits, tool execution failures (agent explains in chat).
- **Auth edge cases:** Token expiry during long sessions, refresh token revocation after months of inactivity, graceful re-auth prompt.
- **UI states:** Input bar disabled while agent is processing, re-enabled after response completes or approval card is resolved. Loading/typing indicator.
- **System prompt refinement:** Tune based on real usage — handling ambiguous requests, formatting quality, recurring event scope prompts.
- **Tests:** Settings/sign-out flow, error state rendering, approval card component tests, agent integration tests (full graph execution with mocked Google APIs for representative user queries).

---

## Principles

- **Vertical slices over horizontal layers.** Each phase produces a working, demoable increment.
- **Walking skeleton first.** Phase 1 is the critical path — once the skeleton walks, phases 2–4 are additive and follow the same pattern.
- **Test in the phase that introduces the risk.** Auth, SSE, and HITL tests ship with the phase that builds them, not in a deferred testing phase. Each phase includes its own tests.
- **Ship the loop early.** The auth → chat → stream → display loop in Phase 1 is the foundation everything else builds on. Get it working on a real device before adding tools.
