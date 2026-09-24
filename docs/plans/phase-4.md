# Task: Implement Phase 4 — Gmail (minimal)

## Problem Statement

Phase 3 is closed (on-device pass recorded in `docs/plans/phase-3-test.md`; B8 is a code-review-only case, C1 is a known Flash-Lite prompt-adherence miss). Phase 4 adds Gmail on the same tool + HITL foundation. The app stays unpublished, so the scope is `gmail.modify` and the headline use case is inbox cleanup.

On 2026-09-15 the feature set was cut to the routine cases. Eight capabilities, one new approval-card layout, no outbound mail:

| Capability              | Tool                   | HITL | Notes                                                                   |
| ----------------------- | ---------------------- | ---- | ----------------------------------------------------------------------- |
| Search messages         | `search_gmail`         | No   | Sender, subject, date, snippet. Gmail query syntax.                     |
| Read one message        | `get_gmail_message`    | No   | Decoded body, truncated.                                                |
| Read a thread           | `get_gmail_thread`     | No   | Every message in the conversation, each truncated.                      |
| List labels             | `list_gmail_labels`    | No   | Plumbing so the agent can resolve label names to IDs.                   |
| Archive, label, unlabel | `modify_gmail_labels`  | Yes¹ | `batchModify`. Archive = remove `INBOX`.                                |
| Mark read / unread      | `modify_gmail_labels`  | No   | ¹ UNREAD-only changes bypass approval, mirroring task status-only.      |
| Trash                   | `trash_gmail_messages` | Yes  | Reversible for 30 days. Permanent delete is impossible under the scope. |
| Create label            | `create_gmail_label`   | No   | Needed for "label everything from my landlord as Housing".              |
| Create draft            | `create_gmail_draft`   | No   | New message or reply draft. Nothing leaves the account.                 |

Deliberately dropped (revisit later if useful): thread search, spam marking, star, send, reply send. `modify_gmail_labels` rejects `SPAM` and `STARRED` at the schema level so the dropped features cannot be reached through the generic tool.

Also in scope:

1. Add `https://www.googleapis.com/auth/gmail.modify` to the mobile scope list; existing sessions re-auth with updated wording.
2. Per-call cap on `messageIds` for the two bulk tools.
3. Approval card renders a message list (count, sender, subject) for bulk actions.
4. System prompt: UNREAD-only bypass line. The Gmail query-syntax, untrusted-content, and fresh-tool-call rules already shipped.
5. Docs pass: PRD 5.3, TRD 3.4 and 7.3, and BUILD.md Phase 4 currently describe the larger feature set and must be trimmed to match this brief.
6. Unit tests (tools, MIME helpers, prompt, agent bound-tool names, mobile payload validation, auth scopes) plus `docs/plans/phase-4-test.md`.

Out of scope: send and reply, spam, star, permanent delete / `batchDelete`, Gmail settings and filters, attachments beyond listing filenames, HTML composition, multi-account, pagination beyond a truncation note.

## Relevant Files

### Backend — create

- `backend/src/tools/gmail.ts` — the eight tools, `GMAIL_API_BASE_URL = 'https://www.googleapis.com/gmail/v1'`, `export const gmailTools`.
- `backend/src/utils/mime.ts` — decode base64url part bodies, walk `payload.parts` preferring `text/plain` then tag-stripped `text/html`, header lookup (`From`, `Subject`, `Date`, `Message-ID`), build an RFC 2822 string and base64url-encode it for the draft `raw`. Node `Buffer` handles `base64url` natively; no new dependency.
- `backend/src/__tests__/tools/gmail.test.ts`, `backend/src/utils/__tests__/mime.test.ts`.

### Backend — modify

- `backend/src/agent.ts:26-29` — spread `gmailTools` into `allTools` (single registration point; feeds both `ToolNode` and `bindTools`).
- `backend/src/prompt.ts:57-82` — add the UNREAD-only exception to the approval rule.
- `backend/src/utils/google-api.ts:156` — 403 message hardcodes "calendar and tasks access".
- `backend/src/__tests__/agent.test.ts:447-466` — bound-tool-names assertion; `backend/src/__tests__/prompt.test.ts`.

### Mobile — modify

- `mobile/src/utils/auth.ts:9-15` (`GOOGLE_SCOPES`), `:114` (insufficient-scope wording).
- `mobile/src/store/auth.ts:27-28` (`SCOPE_MISMATCH_MESSAGE`). `hasRequiredScopes()` and `initialize()` are generic.
- `mobile/src/store/__tests__/auth.test.ts:17-24` (mock factory hardcodes a 5-scope array — must add the new scope), `:41-53`, `:284-357`, `:392-396`; `mobile/src/utils/__tests__/auth.test.ts:131-162`.
- `mobile/src/services/langgraph.ts:46-52` (`InterruptPayload` type), `:136-174` (`extractInterruptPayload` validator), `:680-682` (`isRecord`, which accepts arrays).
- `mobile/src/components/ApprovalCard.tsx:20-42` (renders `Object.entries(current)` / `proposed`), `:103-122` (`ApprovalSection`), `:124-126` (`formatActionLabel`), `:134-184` (`formatValue` stringifies objects to JSON).
- `mobile/src/store/__tests__/chat.test.ts:47-55` (interrupt fixture), `mobile/src/services/__tests__/langgraph.test.ts:255-330` (malformed-payload matrix).

### Mobile — no changes expected

- `mobile/src/store/chat.ts` resume/hydration flow is action-agnostic. `MessageBubble.tsx` already renders the card full-width.

### Docs

- `docs/PRD.md:94-110` (5.3 operations table), `docs/TRD.md:221-235` (tool table and footnote ²), `docs/TRD.md:475-493` (endpoints), `docs/BUILD.md:57-67` (Phase 4 bullets) — trim to this brief in the first slice.
- `docs/plans/phase-4.md` (plan, produced by task-plan), `docs/plans/phase-4-test.md` (manual pass; clone sections A, E, F structure from phase 3).

## Patterns & Conventions Observed

### Backend (follow exactly; `tools/tasks.ts` is the reference)

- Tool shape: `tool(async (input, config) => string, { name, description, schema })`. First line `getAccessToken(config)`. Return formatted strings, never JSON. List lines end with `(id: ...)` for the agent; the prompt forbids showing IDs to users.
- URL builders use `new URL` + `searchParams.set` + `encodeURIComponent` per path segment; tests assert the full ordered URL literal and `{ method: 'GET' }` by deep equality.
- Writes: `{ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(...) }` with the body built by a pure `buildXRequestBody()` so tests can assert exact output.
- `fetchWithAuth<T>` returns `T | null`; callers handle null with `?? []`, `?? { id }`, or a "Google did not return..." message after an approved write. 204 and empty bodies map to null, which is what `batchModify` returns on success.
- Missing resource: `error instanceof GoogleApiError && error.status === 404` → friendly string, never throw. `isMissingResourceStatus` (404/410) lives in `calendar.ts:92-95` and is not shared; promote or duplicate.
- Truncation: explicit `maxResults`, then append `\n\nNote: only the first N ... are shown; more exist. Tell the user the list is incomplete.` when `nextPageToken` is present.
- HITL: pre-fetch current → short-circuit if missing or already in target state → `interrupt<Payload, 'approve' | 'reject'>({ action, description, current, proposed })` → `if (decision !== 'approve') return 'X cancelled.'` → write → 404 on write → "It may no longer exist." Delete-style tools pass `proposed: null`. Snapshots exclude IDs and use human-readable keys (commits `00a420c`, `3771a3f`); the card labels keys by splitting camelCase and sentence-casing.
- Status-only bypass precedent: `isStatusOnlyUpdate()` at `tasks.ts:333-340`, described in both the field `.describe()` and the tool description.
- Tests: `vi.mock` with `importOriginal` spread for `@langchain/langgraph` (`interrupt`) and `../../utils/google-api.js` (`fetchWithAuth`), tools imported after the mocks, `afterEach` resets, token literal `'token-123'`, `mockResolvedValueOnce` chains for multi-call flows, full deep-equality on interrupt payloads.

### Mobile

- Scope expansion: append to `GOOGLE_SCOPES`, reword two messages, update the hardcoded mock array and add a "missing the gmail scope" test in each auth test file.
- Approval card: plain `View` map of rows inside an inverted `FlatList`. No nested scrollers (RN nested-VirtualizedList warning; the list also dismisses the keyboard on drag). Existing clipping conventions are `numberOfLines={1}` and a fixed pixel `maxHeight`. No component tests exist, but `@testing-library/react-native` and `jest-expo` are installed.
- Interrupt detection is post-stream via thread state (`phase-2.md:152`), so payload changes need no SSE work.

## Constraints & Risks

### 1. Search is N+1

`users.messages.list` returns only `id`/`threadId`. Rendering sender, subject, and date requires one `messages.get?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` per result. Do these with `Promise.all` (bounded concurrency), cap search results (recommend 20, schema max 50), and include `snippet`. Quota is fine: 5 + 20×20 = 405 units against 6,000 units per user per minute. Latency is the concern: each `fetchWithAuth` has a 10 s timeout, and sequential gets would be ~3 s for 20 results.

### 2. No byte budget in context windowing

`window-messages.ts` counts messages only (60 for model context, 2,000 retained for 30 days) and `toolsNode` does not truncate tool output. One `get_gmail_thread` with full bodies can be hundreds of KB and is replayed on every turn for the 4-hour sitting. Mitigations belong in the tools: search returns metadata + snippet only; `get_gmail_message` and `get_gmail_thread` truncate decoded bodies (e.g. 4,000 chars per message, fewer per message in threads) with an explicit "body truncated" note; `format=metadata` for anything that doesn't need a body. A sitting-wide token budget with tool-result stubbing is deferred pending Langfuse evidence; see https://github.com/trannttoan/aisist/issues/32.

### 3. Bulk approval cards must be built from fresh server data

The card shows sender and subject per message. The tool fetches those itself (metadata gets per `messageId`, bounded by the cap) rather than accept model-supplied strings, because the model's copy could be fabricated or injected. This is the pre-interrupt fetch convention applied to N resources, and it is why the cap matters: it bounds both the fetch fan-out and the card length.

### 4. Card payload shape is a landmine

`isRecord()` accepts arrays, so an array `current` would pass validation and render rows labelled "0", "1", "2". A nested array inside `current` renders as one comma-joined JSON blob on an unclipped `Text`. Plan: keep `current` a flat object (e.g. `{ count, label }`), add an optional top-level `messages: Array<{ from, subject, date? }>` to `InterruptPayload`, validate it defensively (drop malformed entries, never null the whole payload), and render it in a new card section. No message IDs on the card (phase-3 E6 precedent). `formatActionLabel` produces "Trash gmail messages" (lowercase gmail); decide whether to special-case.

### 5. Trash has no batch endpoint

`messages.trash` is per message (20 units each). Whether `batchModify` with `addLabelIds: ['TRASH']` is accepted was the open question here. Verified, see Resolved 7: Google accepts it, so `trash_gmail_messages` is one call at 50 units.

### 6. Reply drafts need threading headers

A draft joins an existing thread only when `threadId` is set on the draft body and, per Google's guidance, `In-Reply-To` and `References` match the parent's `Message-ID` with a `Re:` subject. Whether `threadId` alone is enough for a draft is **unverified**; check with a real token. If the full header set is required, `create_gmail_draft` with `threadId` fetches the last message's `Message-ID` header first. If that proves fiddly, drop reply drafts and keep new-message drafts only. Plain-text bodies, single `to`, optional `cc`.

### 7. UNREAD-only bypass applies to bulk

Marking 50 messages read without approval is the reversible-status precedent from tasks and matches the PRD. Any call that also touches another label interrupts. Mirror `isStatusOnlyUpdate` as a pure predicate over `addLabelIds`/`removeLabelIds`.

### 8. Label names vs IDs

System labels (`INBOX`, `UNREAD`, `IMPORTANT`) can be used directly. Custom labels must be resolved via `list_gmail_labels`, or created via `create_gmail_label` when absent; the schema description must say IDs come from those tools. The card shows label names, so `modify_gmail_labels` needs the label name for the description (one `labels.get`, or a `labels.list` it already performs). `SPAM` and `STARRED` are rejected by the schema.

### 9. Pre-existing scope-persistence bug

`mobile/src/store/auth.ts:123` re-persists `scopes: GOOGLE_SCOPES` (the required list, not the granted list) on every token refresh. A pre-Gmail session that refreshes before the next `initialize()` gets its stored scopes overwritten, and the mismatch check is defeated on later launches. Exists today for the tasks scope. Fix it in the scope subtask or accept it explicitly.

### 10. Prompt adherence is not a safety boundary

Phase 3 C1 failed (agent created without asking which list). Flash-Lite follows prompt rules unreliably, so every Gmail safety property is tool-enforced: the cap is a schema `max`, the bypass is a predicate, the fresh-metadata fetch is unconditional, the SPAM/STARRED exclusion is a schema refinement. Prompt rules are for quality only.

### 11. Testing-mode token expiry

Refresh tokens die after 7 days in Testing mode. Adding the scope forces one re-auth; nothing new, but section A of the test plan should cover the upgrade path again.

### 12. Other API facts

`batchModify` accepts up to 1,000 ids and returns an empty body. `messages.list` `maxResults` defaults to 100, max 500; `resultSizeEstimate` is available for the truncation note. `threads.get` costs 40 units, `messages.get` 20, `messages.trash` 20, `batchModify` 50, `drafts.create` 10, `labels.create` 5, `labels.list` 1.

## Open Questions

None. All decided 2026-09-15.

## Resolved (do not re-open)

1. Feature set is the minimal eight capabilities above. Send, reply send, spam, star, and thread search are deferred; the generic label tool blocks `SPAM`/`STARRED` at the schema.
2. `create_gmail_label` is in scope, auto-approved (reversible, 5 units).
3. Slice order: scope + `list_gmail_labels` + docs trim (walking skeleton) → `search_gmail`, `get_gmail_message`, `get_gmail_thread` with `mime.ts` → `modify_gmail_labels` with the bypass predicate and the card extension → `trash_gmail_messages` and `create_gmail_label` → `create_gmail_draft` → test doc and on-device pass.
4. **Per-call `messageIds` cap is 50** for both bulk tools, as a backend constant and schema `max`. A later polish phase adds a settings option so the user can change it; keep the constant in one place so that is a one-line wiring change.
5. **Bulk card layout:** a "Messages (N)" section listing `sender — subject` rows with `numberOfLines={1}`, first 10 visible plus a "+ N more" row, no nested scroller. The Current section carries `count` and the label affected; Proposed states the change in words ("Remove from Inbox", "Move to Trash").
6. **Reply drafts stay in scope** pending the header check in Risk 6. If `threadId` alone does not attach a draft to a thread and the full header set proves fiddly, cut to new-message drafts within the draft subtask rather than expanding it.
7. **`batchModify` accepts `TRASH`** (probed against the live API on 2026-09-24 with a one-hour OAuth Playground token). It leaves the same `labelIds` as `messages.trash` — `TRASH` added, `INBOX` removed by Gmail — and `untrash` restores identically after either path. The batch is atomic and answers 400 `invalidArgument` when any ID is unknown, which both bulk tools report as "nothing was changed". `trash_gmail_messages` is therefore one call at 50 quota units. Recorded in TRD 7.3.

## Additional Notes

- Google Cloud: `gmail.modify` is declared on the consent screen and the Gmail API is enabled (checked 2026-09-13). Nothing external blocks slice 1.
- The docs trim in slice 1 also removes the send/reply endpoints from TRD 7.3 and the send row from PRD 5.3, and moves send and spam to the post-v1.0 roadmap so the decision is recorded.
- HTML-only emails are common (newsletters). The tag-stripping fallback in `mime.ts` only needs to be good enough for summarization; document it as best-effort.
- `docs/VERSIONING.md` still references App Store uploads. Harmless, but could be tidied in the Phase 4 docs pass.

## Plan

Gmail follows the tasks pattern exactly: one `tools/gmail.ts` module exporting `gmailTools`, spread into `allTools`, with the same `fetchWithAuth`, pre-fetch, interrupt, and formatting conventions. Two things are genuinely new and get their own pieces: a `utils/mime.ts` helper (decode bodies, pick a text part, build a plain-text RFC 2822 draft) and a bulk approval payload (`messages` array) with a matching card section on mobile. Every safety property (50-id cap, UNREAD-only bypass, SPAM/STARRED exclusion, fresh metadata for the card) is enforced in tool schemas and code, never in the prompt. Slices are vertical: the first one lands the scope, the docs trim, and one working Gmail tool on device; each later slice adds one capability group end to end with its tests.

**Alternatives considered and rejected:**

- **Gmail batch HTTP endpoint** (`POST /batch/gmail/v1`, multipart) for the per-message metadata fan-out. One round trip instead of N, but it needs multipart request building and response parsing, which `fetchWithAuth` (JSON only) does not support. `Promise.all` with a concurrency of 5 stays inside the existing helper and is fast enough at the 20-result search cap and 50-id bulk cap.
- **Encode the message list as a string inside `current`** so the card needs no changes. Zero mobile work, but it renders as one unclipped multi-line value with no per-row truncation and no "+ N more", which contradicts the approved layout. A dedicated `messages` field with a defensive validator is a small, contained change.
- **A mail-parsing dependency** (`mailparser` / `nodemailer`) for MIME. Overkill for plain-text drafts and text-part extraction; Node's `Buffer` handles base64url, and the part walk is ~40 lines. Hand-rolled and unit-tested.
- **Per-message `messages.trash` from the start.** `batchModify` with `TRASH` is one call if Google accepts it; the trash subtask verifies with a real token and falls back to per-message calls only if it must.

**Backend constants** (all in `tools/gmail.ts`, one place so a settings knob later is a single wiring change): `MAX_BULK_MESSAGE_IDS = 50`, `DEFAULT_SEARCH_RESULTS = 20`, `MAX_SEARCH_RESULTS = 50`, `MAX_MESSAGE_BODY_CHARS = 8000` (head and tail kept), `MAX_THREAD_MESSAGE_BODY_CHARS = 1500` (applied after quoted replies are stripped), `MAX_THREAD_MESSAGES = 25`, `METADATA_FETCH_CONCURRENCY = 5`.

**Bulk interrupt payload contract** (both bulk tools):

```ts
interrupt<
  {
    action: 'modify_gmail_labels' | 'trash_gmail_messages';
    description: string; // "Archive 12 messages." / "Add label \"Housing\" to 3 messages." / "Move 5 messages to Trash."
    current: { count: number };
    proposed: { change: string } | null; // null for trash
    messages: Array<{ from: string; subject: string; date: string }>; // fetched server-side, no IDs
  },
  'approve' | 'reject'
>;
```

No `docs/adr/` or `docs/architecture.md` exists; the design decisions above are recorded here and in the TRD trim (Subtask 1.2).

## Subtasks

### Slice 1: Walking skeleton — scope, docs trim, first Gmail tool on device

#### 1.1 — OAuth scope expansion + scope-persistence fix

- **Description**: Append `https://www.googleapis.com/auth/gmail.modify` to `GOOGLE_SCOPES` (`mobile/src/utils/auth.ts:9-15`). Reword the insufficient-scope message (`utils/auth.ts:114`), `SCOPE_MISMATCH_MESSAGE` (`store/auth.ts:27-28`), and the backend 403 wording (`backend/src/utils/google-api.ts:156`) to "calendar, tasks, and Gmail access". Fix the persistence bug at `store/auth.ts:123`: on token refresh, persist the session's stored granted scopes, not `GOOGLE_SCOPES`. Update the hardcoded mock scope array (`store/__tests__/auth.test.ts:17-24`) and `baseSession.scopes`; add "signs out when stored scopes are missing the gmail scope" and "refresh preserves granted scopes" tests; add the gmail analogue of the missing-tasks-scope test in `utils/__tests__/auth.test.ts:146-162`.
- **Files involved**: `mobile/src/utils/auth.ts`, `mobile/src/store/auth.ts`, `mobile/src/store/__tests__/auth.test.ts`, `mobile/src/utils/__tests__/auth.test.ts`, `backend/src/utils/google-api.ts`, `backend/src/utils/__tests__/google-api.test.ts`
- **Prerequisites**: none (scope already declared in the Google console)
- **Acceptance criteria**: Mobile jest and backend vitest suites pass. A stored session lacking the gmail scope is signed out on `initialize()` with the new message. After a mocked refresh, `auth_granted_scopes` still holds the pre-refresh granted list. On device: Phase 3 session is forced out with the new wording; fresh sign-in shows the Gmail permission on the consent screen.
- **Estimated scope**: large

#### 1.2 — Docs trim to the minimal feature set

- **Description**: Align the spec docs with this brief. PRD 5.3: drop "Mark spam / not spam" and "Send / reply" rows, add "Create label (No)"; PRD 11 non-goals add send/reply, spam, star; PRD 12 roadmap add "Gmail send / reply" and "Spam and star" rows. TRD 3.4: replace the Gmail tool table with the eight tools (remove `search_gmail_threads`, `send_gmail_message`; add `create_gmail_label`), keep footnote ², add the `messages` field and 50-id cap to the footnote. TRD 7.3: remove `messages/send`, add `labels.create`, note `batchModify` `TRASH` pending verification. BUILD.md Phase 4: rewrite bullets to match. Run prettier.
- **Files involved**: `docs/PRD.md`, `docs/TRD.md`, `docs/BUILD.md`
- **Prerequisites**: none
- **Acceptance criteria**: `grep -n "send_gmail\|search_gmail_threads\|Mark spam" docs/PRD.md docs/TRD.md docs/BUILD.md` returns nothing outside the non-goals and roadmap sections. `pnpm format:check` passes.
- **Estimated scope**: medium

#### 1.3 — `list_gmail_labels` + module skeleton + registration

- **Description**: Create `backend/src/tools/gmail.ts` with `GMAIL_API_BASE_URL`, the constants above, and `list_gmail_labels` (no inputs; `GET /users/me/labels`; formats `- {name} ({type}) (id: {id})`, system labels first; empty → "No labels found."). Export `gmailTools`. Spread into `allTools` in `agent.ts:26-29`. Add `list_gmail_labels` to the bound-tool-names assertion in `agent.test.ts:447-466`.
- **Files involved**: `backend/src/tools/gmail.ts` (create), `backend/src/__tests__/tools/gmail.test.ts` (create), `backend/src/agent.ts`, `backend/src/__tests__/agent.test.ts`
- **Prerequisites**: 1.1 for on-device verification only
- **Acceptance criteria**: Unit tests: URL literal, formatting, empty state, null body, missing-token `AisistAuthError`. On device: "what Gmail labels do I have?" lists them with no IDs shown.
- **Estimated scope**: medium

---

### Slice 2: Reads

#### 2.1 — `utils/mime.ts` decode side

- **Description**: Pure helpers over the Gmail `Message` resource: `getHeader(payload, name)` (case-insensitive), `decodeBase64Url(data)` via `Buffer`, `extractTextBody(payload)` (walk `parts` depth-first, prefer `text/plain`, else `text/html` with tags stripped and entities `&amp; &lt; &gt; &quot; &#39; &nbsp;` decoded, collapse whitespace), `truncateBody(text, max)` appending `\n[body truncated]`, `listAttachmentNames(payload)` (parts with `filename`).
- **Files involved**: `backend/src/utils/mime.ts` (create), `backend/src/utils/__tests__/mime.test.ts` (create)
- **Prerequisites**: none
- **Acceptance criteria**: Tests cover: single-part plain, multipart/alternative picks plain over html, html-only strips tags and decodes entities, nested multipart/mixed with attachment, missing body → empty string, non-ASCII round trip, truncation note appended only when exceeded.
- **Estimated scope**: medium

#### 2.2 — `search_gmail`

- **Description**: Schema: `query` (string, Gmail search syntax, description gives examples `from:`, `newer_than:7d`, `is:unread`, `category:promotions`), `maxResults` (optional int 1–50, default 20), `includeSpamTrash` (optional bool). `GET /users/me/messages?q=&maxResults=` then metadata gets (`format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`; the parameter is repeated, not comma-joined) with concurrency 5. Format per line: `- {date} — {from} — {subject}{ [unread]}: {snippet} (id: {id}, thread id: {threadId})`. Empty → "No messages match that search." Truncation note when `nextPageToken`: "Note: only the first N of about {resultSizeEstimate} matching messages are shown. Tell the user the list is incomplete and suggest narrowing the query." A metadata get that 404s is dropped silently.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`
- **Prerequisites**: 1.3, 2.1
- **Acceptance criteria**: Tests: list URL literal, one metadata URL per id, ordering preserved, unread marker, empty, truncation note, dropped 404, schema rejects `maxResults: 51`. On device: "any emails from Amazon this week?" returns senders and subjects, no IDs.
- **Estimated scope**: medium

#### 2.3 — `get_gmail_message`

- **Description**: Schema: `messageId`. `GET /users/me/messages/{id}?format=full`. Output lines: From, To, Cc (if any), Date, Subject, Status (`unread` / `read`, `in inbox` / `archived`, derived from `labelIds`), Attachments (names), blank line, body capped at 8,000 chars keeping head and tail with an omitted-count note. 404 → "No message found with that ID. It may have been deleted."
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`
- **Prerequisites**: 2.1
- **Acceptance criteria**: Tests: full detail, html-only body, attachment names, truncation, 404, missing token. On device: "what does the DHL email say?" summarises the body.
- **Estimated scope**: small

#### 2.4 — `get_gmail_thread`

- **Description**: Schema: `threadId`. `GET /users/me/threads/{id}?format=full`. Messages in order, each as `--- {date} — {from}` then body with quoted history stripped and capped at 1,500 chars. Cap at 25 messages with a note. 404 → friendly message. Use `{ timeoutMs: 20_000 }` on this call.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`
- **Prerequisites**: 2.3
- **Acceptance criteria**: Tests: multi-message ordering, per-message truncation, message-count cap note, 404. On device: "catch me up on the lease thread" works from a search result.
- **Estimated scope**: small

---

### Slice 3: Label writes + bulk approval card

#### 3.1 — `modify_gmail_labels` with bypass, cap, and bulk interrupt

- **Description**: Schema: `messageIds` (array 1–50, description: "from search_gmail"), `addLabelIds` and `removeLabelIds` (optional arrays of label IDs; description: system labels `INBOX`, `UNREAD`, `IMPORTANT` or IDs from `list_gmail_labels`; archive = remove `INBOX`). `.superRefine`: at least one of add/remove non-empty; no overlap; reject `SPAM`, `STARRED`, `TRASH` anywhere with message "Use trash_gmail_messages to trash; spam and star are not supported." Flow: `getAccessToken` → `isUnreadOnlyChange()` (only `UNREAD` across both arrays) → if so, `batchModify` directly and return "Marked N messages as read/unread." → else `labels.list` (names for the description) + metadata gets per id (concurrency 5; 404s dropped and counted) → if none remain, return "None of those messages exist any more." → `interrupt` with the contract above; description built from the change ("Archive", "Add label \"X\"", "Remove label \"X\"", joined by ", ", plus " N messages.") → reject → "Label change cancelled." → approve → `POST /users/me/messages/batchModify` `{ ids, addLabelIds, removeLabelIds }` (empty body OK) → "Archived 12 messages." style confirmation, mentioning dropped IDs if any. Add one ReAct + interrupt integration test in `agent.test.ts` for this tool.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`, `backend/src/__tests__/agent.test.ts`
- **Prerequisites**: 2.2. Slice 2 (PR #31) shipped only the generic `mapWithConcurrency`; the Gmail-specific block (metadata get per id, 404 → null, filter) is an inline closure in `searchGmail`. Lift it into a private `fetchMessageMetadata(ids, accessToken)` returning `{ messages, droppedCount }` in this subtask and switch `searchGmail` to it, rather than copying the block.
- **Acceptance criteria**: Tests: UNREAD-only skips `interrupt` and calls `batchModify` once; mixed change interrupts; interrupt payload deep-equals the contract with `messages` built from mocked metadata (no IDs); 51 ids rejected by schema; `SPAM` rejected; reject returns cancel string with no write; approve sends the exact `batchModify` body; all-404 short-circuits; dropped ids are reported. Integration: graph interrupts and resumes on approve.
- **Estimated scope**: medium

#### 3.2 — Mobile bulk payload + card section

- **Description**: `InterruptPayload` gains `messages?: Array<{ from: string; subject: string; date?: string }>` (`langgraph.ts:46-52`). `extractInterruptPayload` reads `payload.messages` when it is an array, keeps entries whose `from` and `subject` are strings, and omits the field otherwise; the rest of validation is unchanged. `ApprovalCard`: new `MessageListSection` rendered between the description and Current when `messages` is non-empty: title `Messages ({count})` where count comes from `current.count` when numeric else `messages.length`; rows `{from} — {subject}` with `numberOfLines={1}`; first 10 rows then a muted `+ N more` row; plain `View`, no scroller. `formatActionLabel`: capitalise `gmail` → `Gmail`. Update the chat store fixture and add: langgraph validation tests (valid list, malformed entries dropped, non-array ignored) and the first component test (`ApprovalCard.test.tsx`) asserting 10 rows plus "+ 2 more" for a 12-message payload.
- **Files involved**: `mobile/src/services/langgraph.ts`, `mobile/src/services/__tests__/langgraph.test.ts`, `mobile/src/components/ApprovalCard.tsx`, `mobile/src/components/__tests__/ApprovalCard.test.tsx` (create), `mobile/src/store/__tests__/chat.test.ts`
- **Prerequisites**: 3.1 payload contract agreed (can be built in parallel against the contract)
- **Acceptance criteria**: Mobile jest passes including the new component test. On device: "archive the newsletters from last month" shows a card with eyebrow "Modify Gmail labels", the count, ten sender/subject rows, "+ N more", and Approve archives them in Gmail. Existing calendar and task cards render unchanged (phase 3 sections E and F).
- **Estimated scope**: large

#### 3.3 — Prompt bypass line

- **Description**: Add to the approval rule in `prompt.ts`: "Exception: marking emails read or unread does not need approval — do it directly." Mirror in the TRD 3.6 template. Prompt test asserts the line.
- **Files involved**: `backend/src/prompt.ts`, `backend/src/__tests__/prompt.test.ts`, `docs/TRD.md`
- **Prerequisites**: none
- **Acceptance criteria**: `prompt.test.ts` passes with the new assertion.
- **Estimated scope**: small

---

### Slice 4: Trash + label creation

#### 4.1 — `trash_gmail_messages`

- **Description**: Schema: `messageIds` (1–50). Pre-fetch metadata per id (drop 404s; skip ids already carrying `TRASH` and report "already in Trash") → none left → short-circuit → `interrupt` with `action: 'trash_gmail_messages'`, description "Move N messages to Trash.", `current: { count }`, `proposed: null`, `messages` → reject → "Trash cancelled." → approve → one `batchModify` call with `{ addLabelIds: ['TRASH'] }` (verified, see Resolved 7) → "Moved N messages to Trash. They can be restored from Trash for 30 days." Record the verification result as a comment above the call.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`
- **Prerequisites**: 3.1, 3.2
- **Acceptance criteria**: Tests: payload contract, already-trashed skip, all-gone short-circuit, reject, approve issues the chosen write(s), 51 ids rejected. On device: "trash the promo emails in my inbox" shows the card and the messages land in Gmail's Trash.
- **Estimated scope**: small

#### 4.2 — `create_gmail_label`

- **Description**: Schema: `name` (trimmed, non-empty, max 225 chars). `POST /users/me/labels` `{ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }`. 409 → "A label named \"X\" already exists." Returns `Created label "X" (id: ...)`. Tool description tells the agent to call `list_gmail_labels` first and only create when absent. No HITL.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`, `backend/src/__tests__/agent.test.ts` (bound names)
- **Prerequisites**: 1.3
- **Acceptance criteria**: Tests: exact body, 409, empty name rejected. On device: "label everything from my landlord as Housing" creates the label when missing, then shows the label-change card.
- **Estimated scope**: small

---

### Slice 5: Drafts

#### 5.1 — `utils/mime.ts` build side

- **Description**: `buildRawMessage({ to, cc?, subject, body, inReplyTo?, references? })` → base64url string. Headers: `To`, `Cc`, `Subject` (RFC 2047 `=?UTF-8?B?...?=` when non-ASCII), `In-Reply-To`, `References`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset="UTF-8"`, `Content-Transfer-Encoding: base64`, blank line, base64 body wrapped at 76 chars. CRLF line endings.
- **Files involved**: `backend/src/utils/mime.ts`, `backend/src/utils/__tests__/mime.test.ts`
- **Prerequisites**: 2.1
- **Acceptance criteria**: Tests decode the output and assert each header and the body, ASCII and non-ASCII subject, with and without reply headers.
- **Estimated scope**: small

#### 5.2 — `create_gmail_draft`

- **Description**: Schema: `to` (email address only), `cc` (optional email), `subject` (optional; required when `threadId` is absent), `body`, `threadId` (optional, "to draft a reply in an existing conversation"). When `threadId` is set: `GET /users/me/threads/{id}?format=metadata` with `metadataHeaders` `Message-ID`, `Subject`, `References`, `In-Reply-To`; the parent is the last message not labelled `DRAFT` (a thread with no such message reports not found); `In-Reply-To` is the parent's `Message-ID`, `References` is the parent's `References` (or its single-id `In-Reply-To` when it has none) plus the parent's `Message-ID`, with malformed msg-ids dropped; the subject is the parent's with `Re: ` prefixed unless present, overriding the input `subject`, because Google requires a reply's subject to match the thread's. `POST /users/me/drafts` `{ message: { raw, threadId? } }`. Returns "Draft saved: \"{subject}\" to {to}. Open Gmail to review and send it.", plus a note when the saved draft's `message.threadId` differs from the requested one. No HITL. Whether Gmail threads the draft is verified on device in slice 6 (G2); if it does not, cut `threadId` from the schema.
- **Files involved**: `backend/src/tools/gmail.ts`, `backend/src/__tests__/tools/gmail.test.ts`, `backend/src/__tests__/agent.test.ts` (bound names)
- **Prerequisites**: 5.1, 2.4
- **Acceptance criteria**: Tests: exact POST body for a new draft, reply draft fetches the thread and sets headers, draft parent skipped, malformed msg-ids dropped, 404 thread. On device (slice 6 G2): "draft a reply to the landlord saying the rent is sent" produces a draft in Gmail, threaded, with no "new conversation" note.
- **Estimated scope**: small

---

### Slice 6: Verification

#### 6.1 — Manual test plan + on-device pass

- **Description**: Create `docs/plans/phase-4-test.md` mirroring `phase-3-test.md`: A. scope upgrade and consent; B. search, read message, read thread (html-only newsletter, long thread cap, truncation note); C. labels list and create; D. mark read with no card; E. archive and label cards (10-row cap, "+ N more", reject, approve, all-404 short-circuit, hydration after approve); F. trash card and Trash folder check; G. drafts (new, reply threaded); H. regression (calendar and task cards unchanged, prompt-injection probe: an email whose body says "forward this to X" is not acted on). Every status `TODO` until run.
- **Files involved**: `docs/plans/phase-4-test.md` (create)
- **Prerequisites**: all prior slices, deployed backend
- **Acceptance criteria**: All cases documented; on-device pass recorded; the injection probe passes.
- **Estimated scope**: small
