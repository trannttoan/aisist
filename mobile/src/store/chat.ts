import { create } from 'zustand';

import {
  bootstrapThread as bootstrapRemoteThread,
  extractInterruptPayload,
  type HydratedChatMessage,
  getThreadState,
  type InterruptPayload,
  resumeRun,
  type ResumeRunInput,
  streamRun,
} from '../services/langgraph';
import { generateThreadId } from '../utils/thread';
import { useAuthStore } from './auth';

export type ChatMessage = {
  /**
   * Stable identity for the chat list's React key. Never changes once a cell
   * has rendered, even when hydration swaps `id` for the canonical server id —
   * a changed key would remount the cell, and the inverted list reads a
   * remount at its scroll anchor as a layout change, answering with an
   * animated scroll to the bottom the user never asked for.
   */
  clientKey: string;
  id: string;
  interrupt?: InterruptPayload;
  role: 'user' | 'assistant';
  status?: 'approved' | 'pending_approval' | 'rejected' | 'streaming';
  text: string;
  timestamp?: number | null;
};

type ChatState = {
  bootstrapThread: () => Promise<void>;
  clearError: () => void;
  errorMessage: string | null;
  hasPendingApproval: () => boolean;
  hydrateMessages: (messages: HydratedChatMessage[]) => void;
  isBootstrapping: boolean;
  isSending: boolean;
  messages: ChatMessage[];
  resumeApproval: (
    messageId: string,
    decision: ResumeRunInput['decision'],
  ) => Promise<void>;
  threadId: string | null;
  reset: () => void;
  sendMessage: (text: string) => Promise<void>;
};

const LOCAL_CLIENT_KEY_PREFIX = 'local-';

type StreamedClientKeys = {
  assistant?: string;
  user?: string;
};

const initialChatState = {
  errorMessage: null as string | null,
  isBootstrapping: false,
  isSending: false,
  messages: [] as ChatMessage[],
  threadId: null as string | null,
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...initialChatState,
  bootstrapThread: async () => {
    const authState = useAuthStore.getState();
    const email = authState.email;

    if (!email) {
      throw new Error('User email is unavailable.');
    }

    const accessToken = await authState.getValidToken();
    const threadId = generateThreadId(email);

    set({
      errorMessage: null,
      isBootstrapping: true,
      threadId,
    });

    try {
      const result = await bootstrapRemoteThread(threadId, accessToken);
      let messages = normalizeMessages(result.messages);

      if (result.status === 'interrupted') {
        const interrupt = extractInterruptPayload(
          await getThreadState(threadId, accessToken),
        );

        if (interrupt) {
          messages = upsertInterruptMessage(messages, interrupt);
        }
      }

      set({
        errorMessage:
          result.status === 'error'
            ? 'The previous run did not settle cleanly. Conversation history was reloaded and you can send another message.'
            : null,
        isBootstrapping: false,
        messages,
        threadId,
      });
    } catch (error) {
      set({
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Unable to bootstrap the Aisist thread.',
        isBootstrapping: false,
        threadId,
      });
      throw error;
    }
  },
  clearError: () => {
    set({ errorMessage: null });
  },
  errorMessage: null,
  hasPendingApproval: () =>
    get().messages.some((message) => message.status === 'pending_approval'),
  hydrateMessages: (messages) => {
    set({
      errorMessage: null,
      messages: normalizeMessages(messages),
    });
  },
  isBootstrapping: false,
  isSending: false,
  resumeApproval: async (messageId, decision) => {
    const state = useChatStore.getState();
    const approvalMessage = state.messages.find(
      (message) => message.id === messageId,
    );

    if (approvalMessage?.status !== 'pending_approval') {
      return;
    }

    const threadId = state.threadId;

    if (!threadId) {
      throw new Error('Thread is unavailable.');
    }

    const authState = useAuthStore.getState();
    const accessToken = await authState.getValidToken();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const streamingAssistantKey = createLocalClientKey('assistant');

    set((currentState) => ({
      errorMessage: null,
      isSending: true,
      messages: currentState.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: nextStatus,
            }
          : message,
      ),
    }));

    try {
      await resumeRun({
        accessToken,
        decision,
        onAssistantTextSnapshot: (text) => {
          set((currentState) => ({
            messages: upsertStreamingAssistantSnapshot(
              currentState.messages,
              streamingAssistantKey,
              text,
            ),
          }));
        },
        threadId,
        timezone: getDeviceTimezone(),
      });

      const hydratedState = await hydrateMessagesForThread(
        threadId,
        accessToken,
        { assistant: streamingAssistantKey },
      );

      set({
        ...hydratedState,
        isSending: false,
        threadId,
      });
    } catch (error) {
      try {
        const hydratedState = await hydrateMessagesForThread(
          threadId,
          accessToken,
          { assistant: streamingAssistantKey },
        );

        set({
          ...hydratedState,
          isSending: false,
          threadId,
        });
        return;
      } catch {
        set((currentState) => ({
          errorMessage:
            'Your approval may have been received. Reopen the app once you are back online to reload the conversation.',
          isSending: false,
          messages: currentState.messages
            .filter((message) => message.clientKey !== streamingAssistantKey)
            .map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    status: 'pending_approval',
                  }
                : message,
            ),
        }));
      }

      throw error;
    }
  },
  reset: () => {
    set(initialChatState);
  },
  sendMessage: async (text) => {
    const trimmedText = text.trim();

    if (!trimmedText) {
      return;
    }

    const state = useChatStore.getState();

    if (state.isSending) {
      return;
    }

    let threadId = state.threadId;

    if (!threadId) {
      await state.bootstrapThread();
      threadId = useChatStore.getState().threadId;
    }

    if (!threadId) {
      throw new Error('Thread bootstrap did not produce a thread ID.');
    }

    const authState = useAuthStore.getState();

    if (!authState.email) {
      throw new Error('User email is unavailable.');
    }

    const accessToken = await authState.getValidToken();
    const userClientKey = createLocalClientKey('user');
    const userMessage: ChatMessage = {
      clientKey: userClientKey,
      id: userClientKey,
      role: 'user',
      text: trimmedText,
      timestamp: Date.now(),
    };
    const streamingAssistantKey = createLocalClientKey('assistant');

    set((currentState) => ({
      errorMessage: null,
      isSending: true,
      messages: [...currentState.messages, userMessage],
    }));

    try {
      await streamRun({
        accessToken,
        message: trimmedText,
        onAssistantTextSnapshot: (text) => {
          set((currentState) => ({
            messages: upsertStreamingAssistantSnapshot(
              currentState.messages,
              streamingAssistantKey,
              text,
            ),
          }));
        },
        threadId,
        timezone: getDeviceTimezone(),
      });

      set({
        isSending: false,
        ...(await hydrateMessagesForThread(threadId, accessToken, {
          assistant: streamingAssistantKey,
          user: userClientKey,
        })),
        threadId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to send your message to Aisist.';

      set({
        errorMessage,
        isSending: false,
      });

      try {
        set({
          ...(await hydrateMessagesForThread(threadId, accessToken, {
            assistant: streamingAssistantKey,
            user: userClientKey,
          })),
          threadId,
        });
        return;
      } catch {
        set((currentState) => ({
          errorMessage:
            'Your message may have been received. Reopen the app once you are back online to reload the conversation.',
          messages: currentState.messages.filter(
            (m) =>
              m.clientKey !== streamingAssistantKey &&
              m.clientKey !== userClientKey,
          ),
        }));
      }

      throw error;
    }
  },
  threadId: null,
}));

export function resetChatState() {
  useChatStore.getState().reset();
}

async function hydrateMessagesForThread(
  threadId: string,
  accessToken: string,
  streamedKeys: StreamedClientKeys = {},
): Promise<Pick<ChatState, 'errorMessage' | 'messages'>> {
  const hydratedMessages = await bootstrapRemoteThread(threadId, accessToken);
  let messages = carryClientKeys(
    useChatStore.getState().messages,
    normalizeMessages(hydratedMessages.messages),
    streamedKeys,
  );

  if (hydratedMessages.status === 'interrupted') {
    const interrupt = extractInterruptPayload(
      await getThreadState(threadId, accessToken),
    );

    if (interrupt) {
      messages = upsertInterruptMessage(messages, interrupt);
    }
  }

  return {
    errorMessage:
      hydratedMessages.status === 'error'
        ? 'The thread reported an error after streaming. Conversation history was reloaded and you can send another message.'
        : null,
    messages,
  };
}

function normalizeMessages(messages: HydratedChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    clientKey: message.id,
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
}

/**
 * Keeps every rendered cell's clientKey stable across hydration while ids
 * adopt the canonical server values (see the ChatMessage.clientKey doc for
 * why remounts are a problem). Messages the server already knew about are
 * matched exactly by id; the messages this run just streamed have local ids
 * the server has never seen, so their keys are grafted onto the newest
 * hydrated message of the same role that no existing cell claimed.
 */
function carryClientKeys(
  existing: ChatMessage[],
  hydrated: ChatMessage[],
  streamedKeys: StreamedClientKeys,
): ChatMessage[] {
  const keysByServerId = new Map(
    existing.map((message) => [message.id, message.clientKey]),
  );
  const messages = hydrated.map((message) => {
    const carriedKey = keysByServerId.get(message.id);

    return carriedKey ? { ...message, clientKey: carriedKey } : message;
  });

  for (const role of ['assistant', 'user'] as const) {
    const streamedKey = streamedKeys[role];
    const didRenderLocally =
      streamedKey !== undefined &&
      existing.some((message) => message.clientKey === streamedKey);

    if (!didRenderLocally) {
      continue;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (message.role === role && !keysByServerId.has(message.id)) {
        messages[index] = { ...message, clientKey: streamedKey };
        break;
      }
    }
  }

  return messages;
}

function upsertInterruptMessage(
  messages: ChatMessage[],
  interrupt: InterruptPayload,
): ChatMessage[] {
  const interruptMessage: ChatMessage = {
    clientKey: interrupt.id,
    id: interrupt.id,
    interrupt,
    role: 'assistant',
    status: 'pending_approval',
    text: interrupt.description,
    timestamp: null,
  };

  if (!messages.some((message) => message.id === interrupt.id)) {
    return [...messages, interruptMessage];
  }

  return messages.map((message) =>
    message.id === interrupt.id ? interruptMessage : message,
  );
}

function upsertStreamingAssistantSnapshot(
  messages: ChatMessage[],
  clientKey: string,
  text: string,
): ChatMessage[] {
  const existingMessage = messages.find(
    (message) => message.clientKey === clientKey,
  );

  if (!existingMessage) {
    return [
      ...messages,
      {
        clientKey,
        id: clientKey,
        role: 'assistant',
        status: 'streaming',
        text,
        timestamp: Date.now(),
      },
    ];
  }

  return messages.map((message) =>
    message.clientKey === clientKey
      ? {
          ...message,
          status: 'streaming',
          text,
        }
      : message,
  );
}

function createLocalClientKey(role: ChatMessage['role']): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${LOCAL_CLIENT_KEY_PREFIX}${role}-${Date.now()}-${suffix}`;
}

function getDeviceTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone || 'UTC';
}
