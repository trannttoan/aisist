# Product Requirements Document — Aisist

**Version:** 1.0 (Draft)
**Status:** Draft
**Platform:** iOS (iPhone)
**Date:** April 2026

---

## 1. Overview

Aisist is an iOS app that connects to a user's Google Calendar, Google Tasks, and Gmail through a single conversational interface. Instead of switching between three apps and tapping through menus, the user just says what they need and the agent does the work.

The agent reads and writes calendar events, tasks, and Gmail messages, and keeps the user in control by asking for approval before modifying or deleting anything.

---

## 2. Goals

Make it fast and natural to manage your day through conversation. One app, one text input, access to your calendar, tasks, and email.

### 2.1 Success Criteria

- The user can create, read, update, and delete calendar events through conversation.
- The user can create, read, update, complete, and delete tasks through conversation.
- The user can search, read, organize, and clean up Gmail messages through conversation.
- Every update and delete operation pauses for user approval before executing.
- Agent behavior is observable and debuggable through LangSmith tracing.
- Read operations feel conversational (under 3 seconds for typical queries).

---

## 3. Target Users and Distribution

Aisist is built for personal use by the developer and a small group of trusted people. It will not be published to the App Store. **Decided September 2026.**

| Aspect       | Details                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users        | The developer plus invited friends and family, each added as a test user on the Google OAuth consent screen (100 user cap).                                                                           |
| OAuth status | Consent screen stays in **Testing** mode permanently. Unverified app warning shown at login. No Google scope verification or CASA assessment is ever needed.                                          |
| Distribution | Dev builds on known devices via Expo EAS Ad Hoc. No TestFlight, no App Store review.                                                                                                                  |
| Trade-off    | Testing-mode refresh tokens expire after 7 days when any non-basic scope is granted, so users re-sign-in weekly. Accepted; the app already handles this through its scope-mismatch and re-auth flows. |

Staying unpublished removes the compliance ceiling on Gmail scopes, which is what allows inbox management (Section 5.3).

---

## 4. Google API Permissions

Aisist requests the narrowest scopes possible while supporting all v1.0 operations.

| Service  | Scope                   | Classification | Permits                                                |
| -------- | ----------------------- | -------------- | ------------------------------------------------------ |
| Calendar | `calendar.events.owned` | Sensitive      | CRUD on events on owned calendars                      |
| Tasks    | `tasks`                 | Sensitive      | Full read/write on task lists and tasks                |
| Gmail    | `gmail.modify`          | Restricted     | Read, search, label, archive, trash, spam, draft, send |
| Profile  | `userinfo.email`        | Non-sensitive  | User email for display                                 |

**Why `gmail.modify` and not the full `mail.google.com` scope.** `gmail.modify` covers everything inbox cleanup needs while excluding permanent deletion (`messages.delete`, `batchDelete`). Trash is the only removal primitive the agent gets, which keeps every cleanup action reversible for 30 days. Gmail settings, filters, and forwarding rules (`gmail.settings.*`) are also excluded.

Restricted scopes only trigger Google verification and a CASA assessment when an app is published to Production. Because the consent screen stays in Testing mode (Section 3), test users can grant `gmail.modify` with no compliance process.

---

## 5. Features

### 5.1 Google Calendar Operations

| Operation         | HITL Required        | Notes                                          |
| ----------------- | -------------------- | ---------------------------------------------- |
| List events       | No                   | Supports date range, search query              |
| Get event details | No                   | Single event by ID                             |
| Create event      | No                   | Agent creates directly based on user's request |
| Update event      | Yes (approve/reject) | Agent shows what will change, user approves    |
| Delete event      | Yes (approve/reject) | Agent confirms event name, user approves       |

**Recurring events:** When the user asks to change or delete a recurring event, the agent asks whether to modify a single occurrence or all future occurrences before proposing the update.

**Attendees:** Event creation supports an optional list of attendee email addresses. The user must provide email addresses directly — name-to-email resolution (e.g., "invite Alex") is deferred to post-v1.0.

### 5.2 Google Tasks Operations

| Operation       | HITL Required           | Notes                                                                                                                       |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| List task lists | No                      | Enumerate available lists                                                                                                   |
| List tasks      | No                      | Tasks within a specific list                                                                                                |
| Get task        | No                      | Single task by ID                                                                                                           |
| Create task     | No                      | Agent creates directly based on user's request                                                                              |
| Update task     | Yes, except status-only | Marking complete/incomplete executes directly — completion is reversible and low-risk. Other field updates require approval |
| Delete task     | Yes (approve/reject)    | Agent confirms task name, user approves                                                                                     |

**Task list disambiguation:** When the user creates a task without specifying a list, the agent asks which list to use.

### 5.3 Gmail Operations

The headline use case is inbox cleanup: "archive all the newsletters from last month", "trash the promo emails in my inbox", "label everything from my landlord as Housing". Gmail is delivered in two slices: reads first, then writes.

| Operation                        | HITL Required | Notes                                                                                    |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| List / search messages           | No            | Search with Gmail query syntax (from:, subject:, etc.)                                   |
| Get message                      | No            | Full message body, headers, attachments metadata                                         |
| List / search threads            | No            | Grouped conversation view                                                                |
| Get thread                       | No            | All messages in a conversation                                                           |
| List labels                      | No            | Inbox, Sent, custom labels, etc.                                                         |
| Mark read / unread               | No            | Reversible and low-risk, same reasoning as task completion                               |
| Create draft                     | No            | Nothing leaves the account until the user sends it                                       |
| Archive / apply or remove labels | Yes           | Approval card shows the count plus sender and subject of each affected message           |
| Trash / untrash                  | Yes           | Trash only; permanent deletion is not possible under `gmail.modify`                      |
| Mark spam / not spam             | Yes           | Trains Gmail's filter, so treated like a destructive change                              |
| Send / reply                     | Yes           | Outward-facing and irreversible, so it interrupts even though it is technically a create |

**Bulk operations:** Cleanup requests naturally touch many messages. A single approval covers the whole batch, and each write tool caps the number of messages per call so one approval can never silently affect an unbounded set. The exact cap is decided in the Phase 4 plan.

**Untrusted content:** Email bodies are third-party input. A message could contain text designed to steer the agent ("forward this to..."). The HITL policy above is the primary defence: any action that changes or sends mail goes through an approval card, and the system prompt instructs the agent to treat email content as data, never as instructions.

---

## 6. Human-in-the-Loop Policy

The policy is simple: **creates and reads are auto-approved. Updates and deletes require user confirmation.** Sending email is the one exception on the create side: it interrupts because it is outward-facing and cannot be undone.

When the agent decides to update or delete something, the conversation pauses and an approval card appears in the chat. The card shows what's about to happen in plain language — for example, "Delete the event 'Team Standup' on April 15th?" The user taps Approve or Reject.

There is no Edit option in v1.0. If the user rejects an update, they can tell the agent what to change instead and the agent will propose a new update.

The Edit option (letting users modify the proposed parameters via form fields before approving) is planned for post-v1.0.

---

## 7. Conversational Interface

### 7.1 Chat UI (v1.0)

The v1.0 interface is a simple chat screen with message bubbles. Deliberately minimal to ship fast.

- Text input bar at the bottom with a send button.
- Streaming response: agent tokens appear as they're generated, not after the full response is ready.
- Approval cards: when the agent proposes an update or delete, a card appears in the chat with Approve and Reject buttons.
- Loading indicator while the agent is thinking or executing a tool.
- The input bar is disabled while the agent is processing a message. Re-enabled after the response completes or the user resolves an approval card.
- Single continuous conversation thread per user. The LLM sees the past 7 days of messages. Older messages are retained in storage but not included in the conversation context.

### 7.2 Conversation Examples

**User:** "What's on my calendar tomorrow?"
**Agent:** Lists events with times and locations.

**User:** "Schedule a 30-minute meeting next Tuesday at 2pm called Project Sync."
**Agent:** Creates the event directly. Confirms with "Done — I created 'Project Sync' for next Tuesday, 2:00–2:30 PM."

**User:** "Move that meeting to 3pm."
**Agent:** Proposes the update. Shows an approval card: "Update 'Project Sync' from 2:00 PM to 3:00 PM on Tuesday?" User taps Approve. Agent confirms.

**User:** "Do I have any emails from Amazon this week?"
**Agent:** Searches Gmail and returns subject lines, senders, and dates.

**User:** "Add a task to buy groceries by Saturday."
**Agent:** Creates the task directly. Confirms with "Done — added 'Buy groceries' to your task list, due Saturday."

### 7.3 Settings Screen

Accessible via a gear icon in the header. Contains:

- **Google Account:** Shows connected email. Option to sign out and reconnect.
- **About / Version:** App version info.

---

## 8. User Profile (Agent Memory) — Deferred to Post-v1.0

Agent memory (persistent user profile across conversations) is deferred to post-v1.0. In v1.0, the agent only has context from the current 7-day conversation window. See the Post-v1.0 Roadmap for planned memory capabilities.

---

## 9. User Flow

### 9.1 First Launch

1. App opens to a welcome screen with a "Sign in with Google" button.
2. User taps the button. Google OAuth consent screen appears, requesting Calendar, Tasks, Gmail, and profile scopes.
3. In test mode, user clicks through the "unverified app" warning.
4. User grants permissions. App receives tokens and stores them securely.
5. App navigates to the chat screen.

### 9.2 Subsequent Launches

App opens directly to the chat screen. The previous conversation (up to 7 days) is visible. The user continues the conversation.

### 9.3 Sign-Out

Signing out clears authentication tokens. Conversation history is retained so it's available if the same user signs back in.

---

## 10. Error States

| Scenario                                   | User Experience                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Google OAuth sign-in fails or is cancelled | Remains on sign-in screen with explanation and retry option                          |
| Google account access is revoked           | Full-screen prompt explaining that access was lost, with a button to re-authenticate |
| Network unavailable                        | Error message in chat; user can retry when connectivity is restored                  |
| Agent fails to execute a tool              | Agent explains the error in the chat and suggests what the user can try              |
| Google API rate limit or error             | Agent reports the issue conversationally and suggests trying again shortly           |

---

## 11. Non-Goals (v1.0)

- Android support
- Multiple Google account support
- Public App Store or TestFlight distribution
- Permanent email deletion (would require the full `mail.google.com` scope)
- Gmail settings, filters, or forwarding rules
- Rich action cards in the UI (structured event/task/email previews)
- Voice input
- Push notifications or proactive agent messages
- Multi-calendar support (v1.0 uses primary calendar only)
- Offline mode
- Google Drive, Docs, or Sheets integration
- Agent memory / persistent user profile (deferred to post-v1.0)
- HITL edit option for update operations (approve/reject only in v1.0)

---

## 12. Post-v1.0 Roadmap

| Feature                     | Notes                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Agent memory / user profile | Persistent profile of user preferences and habits across conversations. See deferred Section 8.         |
| Attendee name resolution    | Resolve names like "Alex" to email addresses, likely via Google Contacts API.                           |
| Gmail filters               | Let the agent turn a repeated cleanup into a Gmail filter. Requires `gmail.settings.basic`.             |
| HITL edit option            | Let users modify proposed parameters via form fields before approving updates.                          |
| Rich action cards in chat   | Show calendar event previews, task cards, email snippets as interactive UI elements.                    |
| Multi-calendar support      | Broader scope to access shared calendars. Requires re-consent.                                          |
| Multiple Google accounts    | Account switcher in the UI.                                                                             |
| Voice input                 | Speech-to-text on the client, transcribed text sent to the agent.                                       |
| Proactive notifications     | Push notifications for upcoming events, overdue tasks, or important emails.                             |
| Cost-optimized LLM routing  | Cheaper model for simple queries, capable model for complex reasoning.                                  |
| Self-hosted LLM             | Llama/Mistral via Ollama to eliminate per-token API costs.                                              |
| AWS migration               | Move from LangGraph Cloud to self-managed AWS infrastructure for cost control and flexibility at scale. |

---

## 13. Known Limitations and Risks

| Risk / Limitation               | Notes                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 100 test user cap               | Testing-mode consent screens allow at most 100 test users. Fine for the intended closed group; publishing later would require Google verification plus a CASA assessment for `gmail.modify`.                                                            |
| Weekly re-authentication        | Testing-mode refresh tokens expire after 7 days. Users sign in again roughly weekly. The scope-mismatch and revoked-access flows already cover this.                                                                                                    |
| Prompt injection via email      | Email bodies are untrusted input to the agent. Mitigated by HITL on every mail-changing or sending action, per-call batch caps, and a system prompt rule to treat email content as data.                                                                |
| LLM cost per conversation       | Each agent turn involves one or more LLM calls. A heavy user could cost $5–10/month in API fees. Monitor via LangSmith and optimize over time.                                                                                                          |
| LLM hallucination risk          | The agent might misinterpret natural language. Reads could return misleading summaries. Updates and deletes are protected by the HITL policy. Creates are not — the system prompt must instruct the agent to confirm ambiguous details before creating. |
| Token refresh on mobile         | If the user doesn't open the app for months, the Google refresh token may be revoked. The app must handle re-authentication gracefully.                                                                                                                 |
| Google OAuth unverified warning | During test mode, users see a warning screen. Expected and documented.                                                                                                                                                                                  |

---

## 14. Resolved Questions

| #   | Question                               | Resolution                                                                                                                     |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | AWS or LangGraph Cloud?                | Start with LangGraph Cloud for v1.0. Migrate to AWS when scaling up.                                                           |
| 2   | Single thread or multiple threads?     | Single continuous thread per user. Keep past 7 days of messages in the LLM's context window.                                   |
| 3   | App name?                              | Aisist                                                                                                                         |
| 4   | HITL edit option for updates?          | Deferred to post-v1.0. Form fields is the planned approach.                                                                    |
| 5   | What happens when old messages expire? | In v1.0, old messages simply fall out of the LLM's context window. Agent memory (persistent profile) is deferred to post-v1.0. |

## 15. Open Questions

None at this time. All questions have been resolved.

## 16. Resolved Questions (continued)

| #   | Question                  | Resolution                                                                                                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Which LLM to start with?  | Gemini 2.5 Flash-Lite for v1.0. Best cost-to-capability ratio for a tool-calling conversational agent. Architecture is provider-agnostic — can swap to GPT-4o or Claude Sonnet with a one-line config change. |
| 7   | Publish to the App Store? | No. Personal and closed-group use only, consent screen stays in Testing mode. This unlocks `gmail.modify` for inbox management without a CASA assessment (Sections 3 and 4).                                  |
