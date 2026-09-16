<h1 align="center">Aisist</h1>

<p align="center">
  <a href="https://github.com/trannttoan/aisist/actions/workflows/ci.yml"><img src="https://github.com/trannttoan/aisist/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/license/trannttoan/aisist" alt="License">
</p>

A conversational AI assistant for iOS that helps you manage your Google Calendar, Tasks, and Gmail from a single chat interface.

## Overview

Aisist is a personal assistant that brings your Google Calendar, Tasks, and Gmail together in one place. Instead of juggling three separate apps, you tell Aisist what you need in plain language ("move my 2pm to Thursday," "show unread emails from Sarah," "add a task to my work list") and an AI agent figures out the right API calls, executes them, and streams the result back to you in real time. Updates and deletes require your approval before executing, so you stay in control of anything that changes existing data.

## Features

### Search and Discovery

Aisist can pull information from your calendar, tasks, and emails all at once. Ask something like "what's on my plate today" and the agent gathers your upcoming events, pending tasks, and recent emails into a single answer. For Gmail specifically, you describe what you're looking for in plain language ("unread emails from Sarah last week," "messages with attachments from June") and the agent translates that into the right search query behind the scenes. It can also tidy up for you ("archive last month's newsletters," "trash the promo emails in my inbox"), showing you exactly which messages are affected before anything changes.

### Reliable Creation and Updates

You can create events, tasks, and more just by describing them. After every creation, the agent confirms exactly what it made so you can catch mistakes early. For updates and deletes, Aisist takes an extra step: it pauses the conversation and shows you an approval card with the proposed change. Nothing gets modified or removed until you explicitly approve it.

### Conversation Memory

Aisist remembers what you've discussed over a rolling window of recent messages, so you can reference earlier parts of the conversation naturally ("actually, move that meeting to Wednesday instead"). Over time, the agent also learns your habits and preferences, like which calendar you use for work, how you like your task lists organized, or your preferred meeting duration, so it can anticipate what you need with less back-and-forth.

## How It Works

Aisist is split into two components: a React Native mobile client and a LangGraph.js backend. The client handles authentication and the chat UI. The backend runs the AI agent, executes tools against the Google APIs, and manages conversation state. The two communicate over REST and SSE.

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│   iOS App (Expo)     │  REST   │   Backend (LangGraph Cloud)      │
│                      │  + SSE  │                                  │
│  - Chat UI           │◄───────►│  - LangGraph.js Agent            │
│  - Google OAuth      │         │  - Google API Tool Execution     │
│  - Token Storage     │         │  - PostgreSQL Checkpointer       │
│  - SSE Streaming     │         │  - LangSmith Tracing             │
└──────────────────────┘         └──────────────────────────────────┘
         │                                      │
         │ OAuth 2.0                            │ REST (with user's access token)
         ▼                                      ▼
┌──────────────────────┐         ┌──────────────────────────────────┐
│   Google OAuth       │         │   Google APIs                    │
│   (accounts.google)  │         │   - Calendar, Tasks, Gmail       │
└──────────────────────┘         └──────────────────────────────────┘
```

### Agent Graph

Each user message flows through a `StateGraph` with three nodes. A **preprocessing node** runs first: it validates the user's Google token, verifies thread authorization, timestamps incoming messages, and trims the stored conversation to a rolling 30-day window (hard-capped at 2,000 messages). The **agent node** then takes only the current sitting (messages since the last gap of more than 4 hours, capped at 60), injects a dynamic system prompt with the user's timezone and current time, and runs a ReAct loop where the LLM decides which tools to call. A **tools node** executes those calls against the Google APIs using the user's access token, and routes the results back to the agent for the next iteration. The loop continues until the agent produces a final response.

### Streaming

Agent responses stream token-by-token to the client via Server-Sent Events (SSE). When the user sends a message, the client opens an SSE connection and renders tokens as they arrive rather than waiting for the full response. If the agent hits an interrupt (for an update or delete), the interrupt payload is included in the stream and the connection closes with the thread in `interrupted` status.

### Authentication and Security

The client handles the full OAuth lifecycle: PKCE authorization code flow via `expo-auth-session`, token storage in the iOS Keychain via `expo-secure-store`, and silent refresh with a 5-minute expiry buffer and a mutex to prevent concurrent refresh requests. The backend never sees the refresh token and never persists the access token. Instead, the client passes the access token with each request, and the backend validates it against Google's tokeninfo endpoint. The backend also verifies that the thread ID in the request matches `aisist-{sha256(email)}` to prevent cross-user access.

### Human-in-the-Loop

Write tools for updates and deletes call LangGraph's `interrupt()` before executing. The graph checkpoints its state to PostgreSQL and returns the proposed change to the client. The client renders an inline approval card with the details. When the user approves or rejects, the client sends a resume command, the graph picks up from the checkpoint, and the tool either executes or cancels. Creates skip this flow and execute immediately, with the agent confirming what it created.

### Conversation Management

Each user has a single persistent thread, identified by a deterministic UUID derived from their email address. This means the conversation survives app reinstalls and device changes. The last 30 days of messages are stored in PostgreSQL and shown in the app, but the agent only sees the current sitting (messages since the last gap of more than 4 hours, capped at 60) to keep the context window focused and free of stale tool results. All messages are timestamped at creation time; messages without timestamps are dropped during windowing.

### Provider-Agnostic LLM

The agent uses LangChain's `BaseChatModel` interface, which means the underlying LLM can be swapped with a one-line configuration change. The current default is Gemini Flash-Lite for its cost-to-capability ratio, with GPT-4o and Claude as drop-in alternatives.

### Observability

All agent runs are traced in LangSmith, including LLM calls, tool executions, HITL decisions, and errors. This provides full conversation replay for debugging and metrics like token usage, tool success rates, and end-to-end latency per message.

## Tech Stack

### Mobile

| Technology        | Role                          |
| ----------------- | ----------------------------- |
| Expo 56           | React Native managed workflow |
| expo-auth-session | Google OAuth 2.0 with PKCE    |
| expo-secure-store | iOS Keychain token storage    |
| Zustand           | Client-side state management  |

### Backend

| Technology            | Role                                          |
| --------------------- | --------------------------------------------- |
| LangGraph.js          | Agent framework                               |
| Gemini 3.1 Flash-Lite | Default LLM, swappable via BaseChatModel      |
| Zod                   | Tool parameter schemas and runtime validation |

### Infrastructure

| Technology      | Role                                          |
| --------------- | --------------------------------------------- |
| LangGraph Cloud | Managed deployment with checkpointing and SSE |
| LangSmith       | Agent tracing and debugging                   |

### Tooling

| Technology      | Role                             |
| --------------- | -------------------------------- |
| TypeScript      | Shared across mobile and backend |
| pnpm workspaces | Monorepo dependency management   |
