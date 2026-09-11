import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

jest.mock('../../services/langgraph', () => ({
  bootstrapThread: jest.fn(),
  extractInterruptPayload: jest.fn(),
  getThreadState: jest.fn(),
  resumeRun: jest.fn(),
  streamRun: jest.fn(),
}));

jest.mock('../../utils/thread', () => ({
  generateThreadId: jest.fn(() => 'deterministic-thread-id'),
}));

jest.mock('../auth', () => ({
  useAuthStore: {
    getState: jest.fn(() => ({
      email: 'test@example.com',
      getValidToken: jest.fn(() => Promise.resolve('access-token')),
    })),
  },
}));

type LoadedChatModule = {
  chatStore: typeof import('../chat');
  langgraph: typeof import('../../services/langgraph');
};

function loadChatModule(): LoadedChatModule {
  jest.resetModules();

  return {
    chatStore: require('../chat') as typeof import('../chat'),
    langgraph:
      require('../../services/langgraph') as typeof import('../../services/langgraph'),
  };
}

function createInterruptPayload() {
  return {
    action: 'update_calendar_event',
    current: { title: 'Before' },
    description: 'Approve the event update.',
    id: 'interrupt-task-1',
    proposed: { title: 'After' },
  };
}

function createApprovalMessage(
  status: 'approved' | 'pending_approval' | 'rejected' = 'pending_approval',
) {
  return {
    clientKey: 'interrupt-task-1',
    id: 'interrupt-task-1',
    interrupt: createInterruptPayload(),
    role: 'assistant' as const,
    status,
    text: 'Approve the event update.',
    timestamp: null,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
}

describe('useChatStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-15T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('bootstrapThread', () => {
    it('sets threadId and messages on success', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      bootstrapThread.mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'idle',
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      const state = chatStore.useChatStore.getState();

      expect(state.threadId).toBe('deterministic-thread-id');
      expect(state.messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1000,
        },
      ]);
      expect(state.isBootstrapping).toBe(false);
      expect(state.errorMessage).toBeNull();
    });

    it('sets isBootstrapping to true during the call', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);
      let capturedIsBootstrapping = false;

      bootstrapThread.mockImplementation(async () => {
        capturedIsBootstrapping =
          chatStore.useChatStore.getState().isBootstrapping;
        return { messages: [], status: 'idle' };
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      expect(capturedIsBootstrapping).toBe(true);
      expect(chatStore.useChatStore.getState().isBootstrapping).toBe(false);
    });

    it('sets errorMessage on failure and rethrows', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.bootstrapThread)
        .mockRejectedValue(new Error('Network error'));

      await expect(
        chatStore.useChatStore.getState().bootstrapThread(),
      ).rejects.toThrow('Network error');

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBe('Network error');
      expect(state.isBootstrapping).toBe(false);
    });

    it('throws when email is unavailable', async () => {
      const { chatStore } = loadChatModule();
      const authModule = require('../auth') as typeof import('../auth');

      jest.mocked(authModule.useAuthStore.getState).mockReturnValue({
        email: null,
      } as ReturnType<typeof authModule.useAuthStore.getState>);

      await expect(
        chatStore.useChatStore.getState().bootstrapThread(),
      ).rejects.toThrow('User email is unavailable.');
    });

    it('sets errorMessage when bootstrap returns error status', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [],
        status: 'error',
      });

      await chatStore.useChatStore.getState().bootstrapThread();

      expect(chatStore.useChatStore.getState().errorMessage).toMatch(
        /did not settle cleanly/,
      );
    });

    it('appends a pending approval message when bootstrap reports interrupted status', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const interrupt = createInterruptPayload();
      const threadState = {
        tasks: [{ id: 'task-1', interrupts: [{ value: interrupt }] }],
      };

      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          {
            id: 'msg-2',
            role: 'assistant',
            text: 'Need approval',
            timestamp: 1001,
          },
        ],
        status: 'interrupted',
      });
      jest.mocked(langgraph.getThreadState).mockResolvedValue(threadState);
      jest.mocked(langgraph.extractInterruptPayload).mockReturnValue(interrupt);

      await chatStore.useChatStore.getState().bootstrapThread();

      expect(langgraph.getThreadState).toHaveBeenCalledWith(
        'deterministic-thread-id',
        'access-token',
      );
      expect(langgraph.extractInterruptPayload).toHaveBeenCalledWith(
        threadState,
      );
      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1000,
        },
        {
          clientKey: 'msg-2',
          id: 'msg-2',
          role: 'assistant',
          text: 'Need approval',
          timestamp: 1001,
        },
        createApprovalMessage(),
      ]);
      expect(chatStore.useChatStore.getState().hasPendingApproval()).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('appends the user message and calls streamRun with correct params', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const streamRun = jest.mocked(langgraph.streamRun);
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      streamRun.mockResolvedValue(undefined);
      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello agent');

      expect(streamRun).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          message: 'Hello agent',
          threadId: 'thread-1',
        }),
      );
    });

    it('upserts streaming snapshots via onAssistantTextSnapshot callback', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const streamRun = jest.mocked(langgraph.streamRun);
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);
      let capturedMessages: Array<{
        role: string;
        text: string;
        status?: string;
      }> = [];

      streamRun.mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('partial text');
        capturedMessages = chatStore.useChatStore
          .getState()
          .messages.map((m) => ({
            role: m.role,
            text: m.text,
            status: m.status,
          }));
      });
      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const streamingMsg = capturedMessages.find((m) => m.role === 'assistant');

      expect(streamingMsg).toBeDefined();
      expect(streamingMsg?.text).toBe('partial text');
      expect(streamingMsg?.status).toBe('streaming');
    });

    it('hydrates messages from remote after streaming completes', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          { id: 'msg-2', role: 'assistant', text: 'Hi there', timestamp: 1001 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      expect(state.messages).toHaveLength(2);
      expect(state.messages[1]?.text).toBe('Hi there');
      expect(state.isSending).toBe(false);
      expect(langgraph.getThreadState).not.toHaveBeenCalled();
    });

    it('keeps streamed cells on their client keys while adopting server ids', async () => {
      const { chatStore, langgraph } = loadChatModule();
      let streamedClientKeys: string[] = [];

      jest.mocked(langgraph.streamRun).mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('Hi there');
        streamedClientKeys = chatStore.useChatStore
          .getState()
          .messages.map((message) => message.clientKey);
      });
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          { id: 'msg-2', role: 'assistant', text: 'Hi there', timestamp: 1001 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      expect(streamedClientKeys).toHaveLength(2);
      expect(state.messages.map((message) => message.clientKey)).toEqual(
        streamedClientKeys,
      );
      expect(state.messages.map((message) => message.id)).toEqual([
        'msg-1',
        'msg-2',
      ]);
      expect(state.messages[1]?.status).toBeUndefined();
    });

    it('keeps server client keys for messages that were not rendered locally', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          { id: 'msg-2', role: 'assistant', text: 'Hi there', timestamp: 1001 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      // The user bubble rendered optimistically, so its key carries over; no
      // assistant cell ever mounted, so the assistant keeps the server key.
      expect(state.messages[0]?.clientKey).toMatch(/^local-user-/);
      expect(state.messages[1]?.clientKey).toBe('msg-2');
      expect(state.messages[1]?.id).toBe('msg-2');
    });

    it('keeps prior-turn client keys stable across a later hydration', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('Second reply');
      });
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'First', timestamp: 1000 },
          { id: 'msg-2', role: 'assistant', text: 'Reply', timestamp: 1001 },
          { id: 'msg-3', role: 'user', text: 'Second', timestamp: 1002 },
          {
            id: 'msg-4',
            role: 'assistant',
            text: 'Second reply',
            timestamp: 1003,
          },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({
        messages: [
          {
            clientKey: 'local-user-first',
            id: 'msg-1',
            role: 'user',
            text: 'First',
            timestamp: 1000,
          },
          {
            clientKey: 'local-assistant-first',
            id: 'msg-2',
            role: 'assistant',
            text: 'Reply',
            timestamp: 1001,
          },
        ],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore.getState().sendMessage('Second');

      const state = chatStore.useChatStore.getState();

      expect(state.messages.map((message) => message.clientKey)).toEqual([
        'local-user-first',
        'local-assistant-first',
        expect.stringMatching(/^local-user-/) as string,
        expect.stringMatching(/^local-assistant-/) as string,
      ]);
      expect(state.messages.map((message) => message.id)).toEqual([
        'msg-1',
        'msg-2',
        'msg-3',
        'msg-4',
      ]);
    });

    it('appends a pending approval message when hydration reports interrupted status', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const interrupt = createInterruptPayload();
      const threadState = {
        tasks: [{ id: 'task-1', interrupts: [{ value: interrupt }] }],
      };

      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
          {
            id: 'msg-2',
            role: 'assistant',
            text: 'Need approval',
            timestamp: 1001,
          },
        ],
        status: 'interrupted',
      });
      jest.mocked(langgraph.getThreadState).mockResolvedValue(threadState);
      jest.mocked(langgraph.extractInterruptPayload).mockReturnValue(interrupt);
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(langgraph.getThreadState).toHaveBeenCalledWith(
        'thread-1',
        'access-token',
      );
      expect(langgraph.extractInterruptPayload).toHaveBeenCalledWith(
        threadState,
      );
      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: expect.stringMatching(/^local-user-/) as string,
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1000,
        },
        {
          clientKey: 'msg-2',
          id: 'msg-2',
          role: 'assistant',
          text: 'Need approval',
          timestamp: 1001,
        },
        {
          clientKey: 'interrupt-task-1',
          id: 'interrupt-task-1',
          interrupt,
          role: 'assistant',
          status: 'pending_approval',
          text: 'Approve the event update.',
          timestamp: null,
        },
      ]);
    });

    it('clears error and resolves when stream fails but re-hydration succeeds', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.streamRun)
        .mockRejectedValue(new Error('Stream failed'));
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBeNull();
      expect(state.isSending).toBe(false);
      expect(state.messages).toHaveLength(1);
    });

    it('appends a pending approval message when recovery hydration reports interrupted status', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const interrupt = createInterruptPayload();
      const threadState = {
        tasks: [{ id: 'task-1', interrupts: [{ value: interrupt }] }],
      };

      jest
        .mocked(langgraph.streamRun)
        .mockRejectedValue(new Error('Stream failed'));
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'interrupted',
      });
      jest.mocked(langgraph.getThreadState).mockResolvedValue(threadState);
      jest.mocked(langgraph.extractInterruptPayload).mockReturnValue(interrupt);
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: expect.stringMatching(/^local-user-/) as string,
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1000,
        },
        {
          clientKey: 'interrupt-task-1',
          id: 'interrupt-task-1',
          interrupt,
          role: 'assistant',
          status: 'pending_approval',
          text: 'Approve the event update.',
          timestamp: null,
        },
      ]);
    });

    it('shows thread error when stream fails and re-hydration reports error status', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.streamRun)
        .mockRejectedValue(new Error('Stream failed'));
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'error',
      });
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toMatch(/error after streaming/);
      expect(state.isSending).toBe(false);
      expect(state.messages).toHaveLength(1);
    });

    it('removes streaming message when re-hydrate also fails', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.streamRun).mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('partial');
        throw new Error('Stream failed');
      });
      jest
        .mocked(langgraph.bootstrapThread)
        .mockRejectedValue(new Error('Hydrate failed'));
      chatStore.useChatStore.setState({ threadId: 'thread-1' });

      await expect(
        chatStore.useChatStore.getState().sendMessage('Hello'),
      ).rejects.toThrow('Stream failed');

      const assistantMessages = chatStore.useChatStore
        .getState()
        .messages.filter((m) => m.role === 'assistant');

      expect(assistantMessages).toHaveLength(0);
    });

    it('no-ops on empty text', async () => {
      const { chatStore, langgraph } = loadChatModule();

      await chatStore.useChatStore.getState().sendMessage('');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('no-ops on whitespace-only text', async () => {
      const { chatStore, langgraph } = loadChatModule();

      await chatStore.useChatStore.getState().sendMessage('   ');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('no-ops when isSending is already true', async () => {
      const { chatStore, langgraph } = loadChatModule();

      chatStore.useChatStore.setState({
        threadId: 'thread-1',
        isSending: true,
      });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(langgraph.streamRun).not.toHaveBeenCalled();
    });

    it('bootstraps the thread if threadId is null before sending', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const bootstrapThread = jest.mocked(langgraph.bootstrapThread);

      bootstrapThread.mockResolvedValue({ messages: [], status: 'idle' });
      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(bootstrapThread).toHaveBeenCalledTimes(2);
    });

    it('keeps exactly one approval message for a stable interrupt id', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const interrupt = createInterruptPayload();

      jest.mocked(langgraph.streamRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        ],
        status: 'interrupted',
      });
      jest.mocked(langgraph.getThreadState).mockResolvedValue({
        tasks: [{ id: 'task-1', interrupts: [{ value: interrupt }] }],
      });
      jest.mocked(langgraph.extractInterruptPayload).mockReturnValue(interrupt);
      chatStore.useChatStore.setState({
        messages: [
          {
            clientKey: 'interrupt-task-1',
            id: 'interrupt-task-1',
            interrupt,
            role: 'assistant',
            status: 'pending_approval',
            text: 'Approve the event update.',
            timestamp: null,
          },
        ],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore.getState().sendMessage('Hello');

      expect(
        chatStore.useChatStore
          .getState()
          .messages.filter((message) => message.id === 'interrupt-task-1'),
      ).toHaveLength(1);
    });
  });

  describe('hydrateMessages', () => {
    it('normalizes and replaces the message list', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.getState().hydrateMessages([
        { id: 'msg-1', role: 'user', text: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', text: 'Hi', timestamp: 1001 },
      ]);

      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1000,
        },
        {
          clientKey: 'msg-2',
          id: 'msg-2',
          role: 'assistant',
          text: 'Hi',
          timestamp: 1001,
        },
      ]);
    });

    it('clears errorMessage', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({ errorMessage: 'stale error' });
      chatStore.useChatStore.getState().hydrateMessages([]);

      expect(chatStore.useChatStore.getState().errorMessage).toBeNull();
    });
  });

  describe('resumeApproval', () => {
    it('optimistically approves during resume, streams, hydrates, and clears isSending', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const hydration = createDeferred<{
        messages: Array<{
          id: string;
          role: 'assistant' | 'user';
          text: string;
          timestamp: number;
        }>;
        status: 'idle';
      }>();

      jest.mocked(langgraph.resumeRun).mockImplementation(async (input) => {
        expect(input.decision).toBe('approve');
        expect(chatStore.useChatStore.getState().isSending).toBe(true);
        expect(chatStore.useChatStore.getState().messages).toEqual([
          createApprovalMessage('approved'),
        ]);

        await input.onAssistantTextSnapshot?.('Applying approval');

        expect(
          chatStore.useChatStore
            .getState()
            .messages.some((message) => message.status === 'streaming'),
        ).toBe(true);
      });
      jest.mocked(langgraph.bootstrapThread).mockImplementation(async () => {
        expect(chatStore.useChatStore.getState().isSending).toBe(true);
        return hydration.promise;
      });
      chatStore.useChatStore.setState({
        messages: [createApprovalMessage()],
        threadId: 'thread-1',
      });

      const resumePromise = chatStore.useChatStore
        .getState()
        .resumeApproval('interrupt-task-1', 'approve');

      await Promise.resolve();

      expect(chatStore.useChatStore.getState().isSending).toBe(true);

      hydration.resolve({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Approve this', timestamp: 1000 },
          {
            id: 'msg-2',
            role: 'assistant',
            text: 'Approved.',
            timestamp: 1001,
          },
        ],
        status: 'idle',
      });

      await resumePromise;

      expect(langgraph.resumeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          decision: 'approve',
          threadId: 'thread-1',
        }),
      );
      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'user',
          text: 'Approve this',
          timestamp: 1000,
        },
        {
          clientKey: expect.stringMatching(/^local-assistant-/) as string,
          id: 'msg-2',
          role: 'assistant',
          text: 'Approved.',
          timestamp: 1001,
        },
      ]);
      expect(chatStore.useChatStore.getState().isSending).toBe(false);
    });

    it('optimistically rejects during resume before hydration replaces messages', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.resumeRun).mockImplementation(async (input) => {
        expect(input.decision).toBe('reject');
        expect(chatStore.useChatStore.getState().messages).toEqual([
          createApprovalMessage('rejected'),
        ]);
      });
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', text: 'Reject this', timestamp: 1000 },
          {
            id: 'msg-2',
            role: 'assistant',
            text: 'Rejected.',
            timestamp: 1001,
          },
        ],
        status: 'idle',
      });
      chatStore.useChatStore.setState({
        messages: [createApprovalMessage()],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore
        .getState()
        .resumeApproval('interrupt-task-1', 'reject');

      expect(langgraph.resumeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'reject',
        }),
      );
      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'user',
          text: 'Reject this',
          timestamp: 1000,
        },
        {
          clientKey: 'msg-2',
          id: 'msg-2',
          role: 'assistant',
          text: 'Rejected.',
          timestamp: 1001,
        },
      ]);
      expect(chatStore.useChatStore.getState().isSending).toBe(false);
    });

    it('uses canonical hydrated messages when resume fails but recovery succeeds', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest
        .mocked(langgraph.resumeRun)
        .mockRejectedValue(new Error('Resume failed'));
      jest.mocked(langgraph.bootstrapThread).mockImplementation(async () => {
        expect(chatStore.useChatStore.getState().isSending).toBe(true);
        return {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              text: 'Server already handled it.',
              timestamp: 1001,
            },
          ],
          status: 'idle',
        };
      });
      chatStore.useChatStore.setState({
        errorMessage: 'stale error',
        messages: [createApprovalMessage()],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore
        .getState()
        .resumeApproval('interrupt-task-1', 'approve');

      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'assistant',
          text: 'Server already handled it.',
          timestamp: 1001,
        },
      ]);
      expect(chatStore.useChatStore.getState().errorMessage).toBeNull();
      expect(chatStore.useChatStore.getState().isSending).toBe(false);
    });

    it('rolls back to pending approval when both resume and recovery hydration fail', async () => {
      const { chatStore, langgraph } = loadChatModule();

      jest.mocked(langgraph.resumeRun).mockImplementation(async (input) => {
        await input.onAssistantTextSnapshot?.('Applying approval');
        throw new Error('Resume failed');
      });
      jest
        .mocked(langgraph.bootstrapThread)
        .mockRejectedValue(new Error('Hydrate failed'));
      chatStore.useChatStore.setState({
        messages: [createApprovalMessage()],
        threadId: 'thread-1',
      });

      await expect(
        chatStore.useChatStore
          .getState()
          .resumeApproval('interrupt-task-1', 'approve'),
      ).rejects.toThrow('Resume failed');

      expect(chatStore.useChatStore.getState().messages).toEqual([
        createApprovalMessage(),
      ]);
      expect(chatStore.useChatStore.getState().errorMessage).toMatch(
        /approval may have been received/i,
      );
      expect(chatStore.useChatStore.getState().isSending).toBe(false);
      expect(
        chatStore.useChatStore
          .getState()
          .messages.some((message) => message.status === 'streaming'),
      ).toBe(false);
    });

    it('no-ops when the target message is not pending approval', async () => {
      const { chatStore, langgraph } = loadChatModule();

      chatStore.useChatStore.setState({
        messages: [createApprovalMessage('approved')],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore
        .getState()
        .resumeApproval('interrupt-task-1', 'approve');

      expect(langgraph.resumeRun).not.toHaveBeenCalled();
      expect(langgraph.bootstrapThread).not.toHaveBeenCalled();
      expect(chatStore.useChatStore.getState().messages).toEqual([
        createApprovalMessage('approved'),
      ]);
    });

    it('appends a new pending approval message when hydration chains into another interrupt', async () => {
      const { chatStore, langgraph } = loadChatModule();
      const nextInterrupt = {
        action: 'delete_calendar_event',
        current: { title: 'Follow-up' },
        description: 'Approve the follow-up change.',
        id: 'interrupt-task-2',
        proposed: null,
      };

      jest.mocked(langgraph.resumeRun).mockResolvedValue(undefined);
      jest.mocked(langgraph.bootstrapThread).mockResolvedValue({
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            text: 'One more step.',
            timestamp: 1001,
          },
        ],
        status: 'interrupted',
      });
      jest.mocked(langgraph.getThreadState).mockResolvedValue({
        tasks: [{ id: 'task-2', interrupts: [{ value: nextInterrupt }] }],
      });
      jest
        .mocked(langgraph.extractInterruptPayload)
        .mockReturnValue(nextInterrupt);
      chatStore.useChatStore.setState({
        messages: [createApprovalMessage()],
        threadId: 'thread-1',
      });

      await chatStore.useChatStore
        .getState()
        .resumeApproval('interrupt-task-1', 'approve');

      expect(chatStore.useChatStore.getState().messages).toEqual([
        {
          clientKey: 'msg-1',
          id: 'msg-1',
          role: 'assistant',
          text: 'One more step.',
          timestamp: 1001,
        },
        {
          clientKey: 'interrupt-task-2',
          id: 'interrupt-task-2',
          interrupt: nextInterrupt,
          role: 'assistant',
          status: 'pending_approval',
          text: 'Approve the follow-up change.',
          timestamp: null,
        },
      ]);
    });
  });

  describe('hasPendingApproval', () => {
    it('returns false when there is no pending approval message', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        messages: [
          { clientKey: 'msg-1', id: 'msg-1', role: 'assistant', text: 'Hello' },
        ],
      });

      expect(chatStore.useChatStore.getState().hasPendingApproval()).toBe(
        false,
      );
    });

    it('returns true when a pending approval message exists', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        messages: [createApprovalMessage()],
      });

      expect(chatStore.useChatStore.getState().hasPendingApproval()).toBe(true);
    });
  });

  describe('reset / resetChatState', () => {
    it('restores initial state', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        errorMessage: 'some error',
        messages: [
          { clientKey: 'msg-1', id: 'msg-1', role: 'user', text: 'Hello' },
        ],
        threadId: 'thread-1',
      });

      chatStore.useChatStore.getState().reset();

      const state = chatStore.useChatStore.getState();

      expect(state.errorMessage).toBeNull();
      expect(state.isBootstrapping).toBe(false);
      expect(state.isSending).toBe(false);
      expect(state.messages).toEqual([]);
      expect(state.threadId).toBeNull();
    });

    it('resets state via the exported resetChatState function', () => {
      const { chatStore } = loadChatModule();

      chatStore.useChatStore.setState({
        errorMessage: 'some error',
        threadId: 'thread-1',
      });

      chatStore.resetChatState();

      expect(chatStore.useChatStore.getState().threadId).toBeNull();
      expect(chatStore.useChatStore.getState().errorMessage).toBeNull();
    });
  });
});
