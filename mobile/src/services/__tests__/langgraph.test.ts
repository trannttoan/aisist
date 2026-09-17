import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

jest.mock('../sse', () => ({
  consumeSseStream: jest.fn(),
}));

import { consumeSseStream } from '../sse';
import {
  bootstrapThread,
  extractInterruptPayload,
  getMissingLangGraphConfig,
  getThreadState,
  hydrateThreadMessages,
  isLangGraphConfigured,
  resumeRun,
  streamRun,
} from '../langgraph';

function createJsonResponse(
  payload: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
    },
    status: 200,
    ...init,
  });
}

describe('langgraph service', () => {
  const fetchMock = jest.fn<typeof fetch>();

  beforeEach(() => {
    global.fetch = fetchMock as typeof fetch;
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL =
      'https://langgraph.example.com/';
    process.env.EXPO_PUBLIC_LANGGRAPH_ASSISTANT_ID = 'agent';
  });

  afterEach(() => {
    fetchMock.mockReset();
    jest.clearAllMocks();
  });

  it('bootstraps the thread, then hydrates normalized messages', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          status: 'idle',
          thread_id: 'thread-123',
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          values: {
            messages: [
              {
                additional_kwargs: {
                  timestamp: 1_700_000_000_000,
                },
                content: 'Hello',
                id: 'user-1',
                role: 'human',
              },
              {
                content: [{ text: 'Hi ' }, { text: 'there' }],
                id: 'assistant-1',
                kwargs: {
                  additional_kwargs: {
                    timestamp: '1700000000500',
                  },
                },
                type: 'ai',
              },
            ],
          },
        }),
      );

    await expect(
      bootstrapThread('thread-123', 'test-google-token'),
    ).resolves.toEqual({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Hello',
          timestamp: 1_700_000_000_000,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi there',
          timestamp: 1_700_000_000_500,
        },
      ],
      status: 'idle',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://langgraph.example.com/threads',
      expect.objectContaining({
        body: JSON.stringify({
          if_exists: 'do_nothing',
          thread_id: 'thread-123',
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-google-token',
        }),
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://langgraph.example.com/threads/thread-123/state',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer test-google-token',
        }),
        method: 'GET',
      }),
    );
  });

  it('fetches the full thread state including tasks', async () => {
    const stateResponse = {
      tasks: [
        {
          id: 'task-1',
          interrupts: [
            {
              value: {
                action: 'update_calendar_event',
                current: { title: 'Old title' },
                description: 'Update the event title.',
                proposed: { title: 'New title' },
              },
            },
          ],
          name: 'agent',
        },
      ],
      values: {
        messages: [{ content: 'Hello', id: 'msg-1', role: 'human' }],
      },
    };

    fetchMock.mockResolvedValue(createJsonResponse(stateResponse));

    await expect(
      getThreadState('thread-123', 'test-google-token'),
    ).resolves.toEqual(stateResponse);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://langgraph.example.com/threads/thread-123/state',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer test-google-token',
        }),
        method: 'GET',
      }),
    );
  });

  it('extracts the first interrupt payload with a stable synthetic id', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-1',
            interrupts: [
              {
                value: {
                  action: 'update_calendar_event',
                  current: { title: 'Old title' },
                  description: 'Update the event title.',
                  proposed: { title: 'New title' },
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      action: 'update_calendar_event',
      current: { title: 'Old title' },
      description: 'Update the event title.',
      id: 'interrupt-task-1',
      proposed: { title: 'New title' },
    });
  });

  it('extracts delete interrupts with proposed set to null', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-delete',
            interrupts: [
              {
                value: {
                  action: 'delete_calendar_event',
                  current: { title: 'Event to remove' },
                  description: 'Delete the event.',
                  proposed: null,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      action: 'delete_calendar_event',
      current: { title: 'Event to remove' },
      description: 'Delete the event.',
      id: 'interrupt-task-delete',
      proposed: null,
    });
  });

  it('extracts the affected message list on bulk interrupts', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-bulk',
            interrupts: [
              {
                value: {
                  action: 'modify_gmail_labels',
                  current: { count: 2 },
                  description: 'Archive 2 messages.',
                  messages: [
                    {
                      date: 'Tue, 15 Sep 2026 10:00:00 +0000',
                      from: 'Amazon <no-reply@amazon.com>',
                      subject: 'Your order has shipped',
                    },
                    {
                      from: 'Landlord <landlord@example.com>',
                      subject: 'Lease renewal',
                    },
                  ],
                  proposed: { change: 'Archive' },
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      action: 'modify_gmail_labels',
      current: { count: 2 },
      description: 'Archive 2 messages.',
      id: 'interrupt-task-bulk',
      messages: [
        {
          date: 'Tue, 15 Sep 2026 10:00:00 +0000',
          from: 'Amazon <no-reply@amazon.com>',
          subject: 'Your order has shipped',
        },
        {
          from: 'Landlord <landlord@example.com>',
          subject: 'Lease renewal',
        },
      ],
      proposed: { change: 'Archive' },
    });
  });

  it('drops malformed message entries and keeps the rest', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-bulk',
            interrupts: [
              {
                value: {
                  action: 'modify_gmail_labels',
                  current: { count: 1 },
                  description: 'Archive 1 message.',
                  messages: [
                    'not an object',
                    { from: 'Only sender <only@example.com>' },
                    { from: 42, subject: 'Numeric sender' },
                    {
                      date: 99,
                      from: 'Landlord <landlord@example.com>',
                      subject: 'Lease renewal',
                    },
                  ],
                  proposed: { change: 'Archive' },
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      action: 'modify_gmail_labels',
      current: { count: 1 },
      description: 'Archive 1 message.',
      id: 'interrupt-task-bulk',
      messages: [
        {
          from: 'Landlord <landlord@example.com>',
          subject: 'Lease renewal',
        },
      ],
      proposed: { change: 'Archive' },
    });
  });

  it('omits the message list when it is not an array', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-bulk',
            interrupts: [
              {
                value: {
                  action: 'modify_gmail_labels',
                  current: { count: 2 },
                  description: 'Archive 2 messages.',
                  messages: 'nope',
                  proposed: { change: 'Archive' },
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      action: 'modify_gmail_labels',
      current: { count: 2 },
      description: 'Archive 2 messages.',
      id: 'interrupt-task-bulk',
      proposed: { change: 'Archive' },
    });
  });

  it('returns null when tasks are missing', () => {
    expect(extractInterruptPayload({ values: { messages: [] } })).toBeNull();
  });

  it('returns null when tasks are empty', () => {
    expect(extractInterruptPayload({ tasks: [] })).toBeNull();
  });

  it('returns null when tasks have no interrupts', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'task-1',
            interrupts: [],
          },
        ],
      }),
    ).toBeNull();
  });

  it('returns null when the interrupt payload is malformed', () => {
    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'missing-action',
            interrupts: [
              {
                value: {
                  current: { title: 'Old title' },
                  description: 'Missing action.',
                  proposed: { title: 'New title' },
                },
              },
            ],
          },
        ],
      }),
    ).toBeNull();

    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'missing-description',
            interrupts: [
              {
                value: {
                  action: 'update_calendar_event',
                  current: { title: 'Old title' },
                  proposed: { title: 'New title' },
                },
              },
            ],
          },
        ],
      }),
    ).toBeNull();

    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'missing-current',
            interrupts: [
              {
                value: {
                  action: 'update_calendar_event',
                  current: null,
                  description: 'Missing current.',
                  proposed: { title: 'New title' },
                },
              },
            ],
          },
        ],
      }),
    ).toBeNull();

    expect(
      extractInterruptPayload({
        tasks: [
          {
            id: 'missing-proposed',
            interrupts: [
              {
                value: {
                  action: 'update_calendar_event',
                  current: { title: 'Old title' },
                  description: 'Missing proposed.',
                },
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('parses streamed chunk payloads into assistant text snapshots', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'content-type': 'text/event-stream',
        },
        status: 200,
      }),
    );

    jest.mocked(consumeSseStream).mockImplementation(async ({ onEvent }) => {
      await onEvent({
        data: JSON.stringify({
          chunk: {
            delta: [{ text: 'Hello' }],
            role: 'assistant',
          },
        }),
        event: 'messages/partial',
      });
      await onEvent({
        data: JSON.stringify({
          data: {
            message: {
              content: [{ text: 'Hello world' }],
              role: 'assistant',
            },
          },
        }),
        event: 'messages/partial',
      });
      await onEvent({
        data: '[DONE]',
        event: 'message',
      });
    });

    const onAssistantTextSnapshot = jest.fn<() => Promise<void>>();
    const onEvent = jest.fn<() => Promise<void>>();

    await streamRun({
      accessToken: 'google-access-token',
      message: 'Tell me something useful.',
      onAssistantTextSnapshot,
      onEvent,
      threadId: 'thread-123',
      timezone: 'America/Detroit',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://langgraph.example.com/threads/thread-123/runs/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: 'Bearer google-access-token',
        }),
        method: 'POST',
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onAssistantTextSnapshot).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onAssistantTextSnapshot).toHaveBeenNthCalledWith(2, 'Hello world');
  });

  it('posts a resume command and forwards streamed assistant snapshots', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'content-type': 'text/event-stream',
        },
        status: 200,
      }),
    );

    jest.mocked(consumeSseStream).mockImplementation(async ({ onEvent }) => {
      await onEvent({
        data: JSON.stringify({
          chunk: {
            delta: [{ text: 'Approved' }],
            role: 'assistant',
          },
        }),
        event: 'messages/partial',
      });
    });

    const onAssistantTextSnapshot = jest.fn<() => Promise<void>>();

    await resumeRun({
      accessToken: 'google-access-token',
      decision: 'approve',
      onAssistantTextSnapshot,
      threadId: 'thread-123',
      timezone: 'America/Detroit',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://langgraph.example.com/threads/thread-123/runs/stream',
      expect.objectContaining({
        body: JSON.stringify({
          assistant_id: 'agent',
          command: {
            resume: 'approve',
          },
          config: {
            configurable: {
              access_token: 'google-access-token',
              timezone: 'America/Detroit',
            },
          },
          input: null,
          stream_mode: ['messages'],
        }),
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: 'Bearer google-access-token',
        }),
        method: 'POST',
      }),
    );
    expect(onAssistantTextSnapshot).toHaveBeenCalledWith('Approved');
  });

  it('throws when the resume stream emits an error event', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'content-type': 'text/event-stream',
        },
        status: 200,
      }),
    );

    jest.mocked(consumeSseStream).mockImplementation(async ({ onEvent }) => {
      await onEvent({
        data: JSON.stringify({
          error: 'Approval failed.',
        }),
        event: 'error',
      });
    });

    await expect(
      resumeRun({
        accessToken: 'google-access-token',
        decision: 'reject',
        threadId: 'thread-123',
        timezone: 'America/Detroit',
      }),
    ).rejects.toThrow('Approval failed.');
  });

  it('ignores messages/complete events from preprocess node', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      }),
    );

    jest.mocked(consumeSseStream).mockImplementation(async ({ onEvent }) => {
      await onEvent({
        data: JSON.stringify({
          content: [{ text: 'Previous response' }],
          type: 'AIMessage',
        }),
        event: 'messages/complete',
      });
      await onEvent({
        data: JSON.stringify({
          chunk: {
            delta: [{ text: 'New response' }],
            role: 'assistant',
          },
        }),
        event: 'messages/partial',
      });
    });

    const onAssistantTextSnapshot = jest.fn<() => Promise<void>>();

    await streamRun({
      accessToken: 'google-access-token',
      message: 'Second message',
      onAssistantTextSnapshot,
      threadId: 'thread-123',
      timezone: 'America/Detroit',
    });

    expect(onAssistantTextSnapshot).toHaveBeenCalledTimes(1);
    expect(onAssistantTextSnapshot).toHaveBeenCalledWith('New response');
  });

  it('polls until the thread settles when status is busy', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'busy' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'busy' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'idle' }))
      .mockResolvedValueOnce(createJsonResponse({ values: { messages: [] } }));

    jest.useFakeTimers();

    const promise = bootstrapThread('thread-123', 'test-google-token');

    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;

    jest.useRealTimers();

    expect(result.status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('throws when the langgraph api returns an error response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Not found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      }),
    );

    await expect(
      bootstrapThread('thread-123', 'test-google-token'),
    ).rejects.toThrow('Not found');
  });

  it('throws with config hint when 404 and url points to langsmith', async () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL =
      'https://api.smith.langchain.com/';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Not found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      }),
    );

    await expect(
      bootstrapThread('thread-123', 'test-google-token'),
    ).rejects.toThrow('EXPO_PUBLIC_LANGGRAPH_API_URL is pointing to LangSmith');
  });

  it('throws with a non-json error body as the message', async () => {
    fetchMock.mockResolvedValue(
      new Response('Bad Gateway', {
        headers: { 'content-type': 'text/plain' },
        status: 502,
      }),
    );

    await expect(
      bootstrapThread('thread-123', 'test-google-token'),
    ).rejects.toThrow('Bad Gateway');
  });

  it('filters out messages with no role or empty text during hydration', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ thread_id: 'thread-123' }))
      .mockResolvedValueOnce(createJsonResponse({ status: 'idle' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          values: {
            messages: [
              { content: 'Hello', id: 'msg-1', role: 'human' },
              { content: '', id: 'msg-2', role: 'ai' },
              { content: 'No role', id: 'msg-3' },
              { content: 'Reply', role: 'assistant' },
            ],
          },
        }),
      );

    const result = await bootstrapThread('thread-123', 'test-google-token');

    expect(result.messages).toEqual([
      { id: 'msg-1', role: 'user', text: 'Hello', timestamp: null },
      { id: 'assistant-3', role: 'assistant', text: 'Reply', timestamp: null },
    ]);
  });

  it('generates a fallback id when the message has no id field', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        values: {
          messages: [{ content: 'Hello', role: 'human' }],
        },
      }),
    );

    const messages = await hydrateThreadMessages(
      'thread-123',
      'test-google-token',
    );

    expect(messages[0]?.id).toBe('user-0');
  });
});

describe('getMissingLangGraphConfig', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
  });

  it('returns missing env var names when unset', () => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;

    expect(getMissingLangGraphConfig()).toEqual([
      'EXPO_PUBLIC_LANGGRAPH_API_URL',
    ]);
  });

  it('returns an empty array when all vars are set', () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL = 'https://example.com';

    expect(getMissingLangGraphConfig()).toEqual([]);
  });
});

describe('isLangGraphConfigured', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;
  });

  it('returns false when config is missing', () => {
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_URL;
    delete process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY;

    expect(isLangGraphConfigured()).toBe(false);
  });

  it('returns true when config is present', () => {
    process.env.EXPO_PUBLIC_LANGGRAPH_API_URL = 'https://example.com';
    process.env.EXPO_PUBLIC_LANGGRAPH_API_KEY = 'key';

    expect(isLangGraphConfigured()).toBe(true);
  });
});
