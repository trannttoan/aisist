import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  Command,
  INTERRUPT,
  MemorySaver,
  isInterrupted,
} from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../utils/auth.js';
import { fetchWithAuth } from '../utils/google-api.js';
import { generateThreadId } from '../utils/thread.js';
import { getMessageTimestamp, stampMessage } from '../utils/timestamp.js';

const modelInvokeSpy = vi.fn();
const modelBindToolsSpy = vi.fn();

vi.mock('@langchain/google-genai', () => {
  return {
    ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
      bindTools = modelBindToolsSpy.mockImplementation(() => ({
        invoke: modelInvokeSpy,
      }));

      invoke = modelInvokeSpy;
    },
  };
});

vi.mock('../utils/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/auth.js')>();

  return {
    ...actual,
    validateGoogleToken: vi.fn(),
    verifyThreadAuthorization: vi.fn(),
  };
});

vi.mock('../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import { graph, workflow } from '../agent.js';
import {
  validateGoogleToken,
  verifyThreadAuthorization,
} from '../utils/auth.js';

const FIXED_TIMESTAMP = Date.UTC(2026, 0, 15, 10, 0, 0);
const TEST_EMAIL = 'test@example.com';
const TEST_THREAD_ID = generateThreadId(TEST_EMAIL);

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    configurable: {
      access_token: 'test-access-token',
      thread_id: TEST_THREAD_ID,
      timezone: 'America/New_York',
      ...overrides,
    },
  };
}

describe('agent graph', () => {
  beforeEach(() => {
    modelInvokeSpy.mockResolvedValue(new AIMessage('mocked response'));
    modelBindToolsSpy.mockClear();

    process.env.GOOGLE_API_KEY = 'test-api-key';

    vi.mocked(validateGoogleToken).mockResolvedValue({ email: TEST_EMAIL });
    vi.mocked(verifyThreadAuthorization).mockImplementation(() => {});
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIMESTAMP);
  });

  afterEach(() => {
    modelInvokeSpy.mockReset();
    vi.mocked(fetchWithAuth).mockReset();
    vi.restoreAllMocks();
    delete process.env.GOOGLE_API_KEY;
  });

  describe('auth gating', () => {
    it('calls validateGoogleToken with the run config', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      expect(validateGoogleToken).toHaveBeenCalledWith(
        expect.objectContaining({
          configurable: expect.objectContaining({
            access_token: 'test-access-token',
          }),
        }),
      );
    });

    it('calls verifyThreadAuthorization with the validated email', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      expect(verifyThreadAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: TEST_THREAD_ID,
          }),
        }),
        TEST_EMAIL,
      );
    });

    it('rejects when token validation fails', async () => {
      vi.mocked(validateGoogleToken).mockRejectedValue(
        new AisistAuthError('AUTH_INVALID_TOKEN', 'bad token', {
          retryable: false,
          status: 401,
        }),
      );

      await expect(
        graph.invoke({ messages: [new HumanMessage('Hello')] }, buildConfig()),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
    });

    it('rejects when thread authorization fails', async () => {
      vi.mocked(verifyThreadAuthorization).mockImplementation(() => {
        throw new AisistAuthError('AUTH_THREAD_MISMATCH', 'wrong thread', {
          retryable: false,
          status: 403,
        });
      });

      await expect(
        graph.invoke({ messages: [new HumanMessage('Hello')] }, buildConfig()),
      ).rejects.toMatchObject({ code: 'AUTH_THREAD_MISMATCH' });
    });
  });

  describe('preprocessing', () => {
    it('stamps the latest human message with the current timestamp', async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      const humanMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === 'human',
      );

      expect(getMessageTimestamp(humanMessage!)).toBe(FIXED_TIMESTAMP);
    });

    it('keeps older messages in state but sends only the current sitting to the model', async () => {
      const earlierTimestamp = FIXED_TIMESTAMP - 8 * 24 * 60 * 60 * 1000;

      const result = await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage('earlier'), earlierTimestamp),
            stampMessage(new AIMessage('reply'), earlierTimestamp + 1_000),
            new HumanMessage('recent'),
          ],
        },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];
      const humanInputs = invokeArgs.filter(
        (m: { _getType: () => string }) => m._getType() === 'human',
      );

      expect(humanInputs).toHaveLength(1);
      expect(humanInputs[0].content).toBe('recent');
      expect(
        result.messages.some(
          (message: { content: unknown }) => message.content === 'earlier',
        ),
      ).toBe(true);
    });

    it('drops messages older than the retention window from state', async () => {
      const staleTimestamp = FIXED_TIMESTAMP - 31 * 24 * 60 * 60 * 1000;

      const result = await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage('stale'), staleTimestamp),
            new HumanMessage('recent'),
          ],
        },
        buildConfig(),
      );

      expect(
        result.messages.some(
          (message: { content: unknown }) => message.content === 'stale',
        ),
      ).toBe(false);
    });

    it('sends the whole sitting to the model when turns are close together', async () => {
      const earlierTimestamp = FIXED_TIMESTAMP - 60 * 60 * 1000;

      await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage('earlier'), earlierTimestamp),
            stampMessage(new AIMessage('reply'), earlierTimestamp + 1_000),
            new HumanMessage('recent'),
          ],
        },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];

      expect(
        invokeArgs.map((message: { content: unknown }) => message.content),
      ).toEqual([
        expect.stringContaining('You are Aisist'),
        'earlier',
        'reply',
        'recent',
      ]);
    });

    it('starts the model history on a human turn when a sitting begins mid-exchange', async () => {
      const staleTimestamp = FIXED_TIMESTAMP - 31 * 24 * 60 * 60 * 1000;
      const recentTimestamp = FIXED_TIMESTAMP - 29 * 24 * 60 * 60 * 1000;

      await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage('stale question'), staleTimestamp),
            stampMessage(
              new AIMessage({
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    name: 'list_task_lists',
                    args: {},
                    type: 'tool_call',
                  },
                ],
              }),
              staleTimestamp,
            ),
            stampMessage(
              new ToolMessage({
                content: 'Task lists:\n- My Tasks (id: list-1)',
                tool_call_id: 'call-1',
              }),
              recentTimestamp,
            ),
            stampMessage(new AIMessage('You have one list.'), recentTimestamp),
            new HumanMessage('recent'),
          ],
        },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];

      expect(invokeArgs[0]._getType()).toBe('system');
      expect(invokeArgs[1]._getType()).toBe('human');
      expect(invokeArgs[1].content).toBe('recent');
      expect(invokeArgs).toHaveLength(2);
    });
  });

  describe('agent node', () => {
    it('invokes the model with a SystemMessage and the windowed messages', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      const invokeArgs = modelInvokeSpy.mock.calls[0]![0];

      expect(invokeArgs[0]._getType()).toBe('system');
      expect(invokeArgs[1]._getType()).toBe('human');
      expect(invokeArgs[1].content).toBe('Hello');
    });

    it('includes the configured timezone in the system prompt', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig({ timezone: 'America/New_York' }),
      );

      const systemMessage = modelInvokeSpy.mock.calls[0]![0][0];

      expect(systemMessage.content).toContain('America/New_York');
    });

    it('falls back to UTC when timezone is missing', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        {
          configurable: {
            access_token: 'test-access-token',
            thread_id: TEST_THREAD_ID,
          },
        },
      );

      const systemMessage = modelInvokeSpy.mock.calls[0]![0][0];

      expect(systemMessage.content).toContain("User's timezone: UTC");
    });

    it('stamps the model response with a timestamp', async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      const aiMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === 'ai',
      );

      expect(getMessageTimestamp(aiMessage!)).toBe(FIXED_TIMESTAMP);
    });

    it('returns the model response in the messages array', async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      const aiMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === 'ai',
      );

      expect(aiMessage!.content).toBe('mocked response');
    });
  });

  describe('end-to-end', () => {
    it('returns the stamped input and model response', async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]._getType()).toBe('human');
      expect(result.messages[1]._getType()).toBe('ai');
    });

    it('preserves timestamps on earlier messages', async () => {
      const earlierTimestamp = FIXED_TIMESTAMP - 1000;
      const result = await graph.invoke(
        {
          messages: [
            stampMessage(new HumanMessage('first'), earlierTimestamp),
            stampMessage(new AIMessage('reply'), earlierTimestamp + 500),
            new HumanMessage('second'),
          ],
        },
        buildConfig(),
      );

      expect(result.messages).toHaveLength(4);
      expect(getMessageTimestamp(result.messages[0]!)).toBe(earlierTimestamp);
      expect(getMessageTimestamp(result.messages[2]!)).toBe(FIXED_TIMESTAMP);
    });

    it('completes the tool loop when the model calls list_calendar_events', async () => {
      modelInvokeSpy
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'tool-call-1',
                name: 'list_calendar_events',
                args: {
                  timeMin: '2026-01-16T00:00:00-05:00',
                  timeMax: '2026-01-17T00:00:00-05:00',
                },
                type: 'tool_call',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage('You have one event tomorrow: Team Sync at 9:00 AM.'),
        );
      vi.mocked(fetchWithAuth).mockResolvedValue({
        items: [
          {
            id: 'event-1',
            summary: 'Team Sync',
            start: { dateTime: '2026-01-16T09:00:00-05:00' },
            end: { dateTime: '2026-01-16T09:30:00-05:00' },
          },
        ],
      });

      const result = await graph.invoke(
        {
          messages: [new HumanMessage("What's on my calendar tomorrow?")],
        },
        buildConfig(),
      );

      expect(modelBindToolsSpy).toHaveBeenCalled();
      expect(modelInvokeSpy).toHaveBeenCalledTimes(2);
      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/calendars/primary/events?'),
        expect.objectContaining({ method: 'GET' }),
        'test-access-token',
      );

      const secondInvokeArgs = modelInvokeSpy.mock.calls[1]![0];
      const toolMessage = secondInvokeArgs.find(
        (message: { _getType: () => string }) => message._getType() === 'tool',
      );

      expect(toolMessage?.content).toContain('Team Sync');

      const resultToolMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === 'tool',
      );

      expect(getMessageTimestamp(resultToolMessage!)).toBe(FIXED_TIMESTAMP);
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        'You have one event tomorrow: Team Sync at 9:00 AM.',
      );
    });

    it('binds calendar, task, and gmail tools to the model', async () => {
      await graph.invoke(
        { messages: [new HumanMessage('Hello')] },
        buildConfig(),
      );

      const boundTools = modelBindToolsSpy.mock.calls[0]![0] as Array<{
        name: string;
      }>;
      const boundToolNames = boundTools.map((boundTool) => boundTool.name);

      expect(boundToolNames).toContain('list_calendar_events');
      expect(boundToolNames).toContain('list_task_lists');
      expect(boundToolNames).toContain('update_task');
      expect(boundToolNames).toContain('delete_task');
      expect(boundToolNames).toContain('list_gmail_labels');
      expect(boundToolNames).toContain('search_gmail');
    });

    it('completes the tool loop when the model calls list_task_lists', async () => {
      modelInvokeSpy
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'tool-call-1',
                name: 'list_task_lists',
                args: {},
                type: 'tool_call',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage('You have two task lists: My Tasks and Groceries.'),
        );
      vi.mocked(fetchWithAuth).mockResolvedValue({
        items: [
          { id: 'list-1', title: 'My Tasks' },
          { id: 'list-2', title: 'Groceries' },
        ],
      });

      const result = await graph.invoke(
        { messages: [new HumanMessage('What task lists do I have?')] },
        buildConfig(),
      );

      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/tasks/v1/users/@me/lists?'),
        expect.objectContaining({ method: 'GET' }),
        'test-access-token',
      );

      const toolMessage = result.messages.find(
        (m: { _getType: () => string }) => m._getType() === 'tool',
      );

      expect(toolMessage?.content).toContain('My Tasks');
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        'You have two task lists: My Tasks and Groceries.',
      );
    });

    it('interrupts on update_calendar_event and resumes with approval', async () => {
      const interruptibleGraph = workflow.compile({
        checkpointer: new MemorySaver(),
      });

      modelInvokeSpy
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'tool-call-1',
                name: 'update_calendar_event',
                args: {
                  eventId: 'event-1',
                  summary: 'Team Standup',
                },
                type: 'tool_call',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage('I updated the event to Team Standup.'),
        );
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce({
          id: 'event-1',
          summary: 'Team Sync',
          location: 'Room 1',
          description: 'Weekly sync.',
          attendees: [{ email: 'lead@example.com' }],
          start: { dateTime: '2026-03-10T09:00:00-05:00' },
          end: { dateTime: '2026-03-10T09:30:00-05:00' },
        })
        .mockResolvedValueOnce({
          id: 'event-1',
          summary: 'Team Sync',
          location: 'Room 1',
          description: 'Weekly sync.',
          attendees: [{ email: 'lead@example.com' }],
          start: { dateTime: '2026-03-10T09:00:00-05:00' },
          end: { dateTime: '2026-03-10T09:30:00-05:00' },
        })
        .mockResolvedValueOnce({
          id: 'event-1',
          summary: 'Team Standup',
          location: 'Room 1',
          description: 'Weekly sync.',
          attendees: [{ email: 'lead@example.com' }],
          status: 'confirmed',
          start: { dateTime: '2026-03-10T09:00:00-05:00' },
          end: { dateTime: '2026-03-10T09:30:00-05:00' },
        });

      const interruptedResult = await interruptibleGraph.invoke(
        {
          messages: [new HumanMessage('Rename Team Sync to Team Standup.')],
        },
        buildConfig(),
      );

      expect(isInterrupted(interruptedResult)).toBe(true);
      expect(interruptedResult[INTERRUPT][0]?.value).toEqual({
        action: 'update_calendar_event',
        description: 'Update "Team Sync": summary → "Team Standup"',
        current: {
          summary: 'Team Sync',
          startDateTime: '2026-03-10T09:00:00-05:00',
          endDateTime: '2026-03-10T09:30:00-05:00',
          startDate: undefined,
          endDate: undefined,
          location: 'Room 1',
          description: 'Weekly sync.',
          attendees: ['lead@example.com'],
        },
        proposed: {
          summary: 'Team Standup',
        },
      });

      const resumedResult = await interruptibleGraph.invoke(
        new Command({ resume: 'approve' }),
        buildConfig(),
      );

      expect(isInterrupted(resumedResult)).toBe(false);
      expect(fetchWithAuth).toHaveBeenNthCalledWith(
        3,
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1',
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            summary: 'Team Standup',
          }),
        },
        'test-access-token',
      );
      expect(modelInvokeSpy).toHaveBeenCalledTimes(2);
      expect(
        resumedResult.messages[resumedResult.messages.length - 1]?.content,
      ).toBe('I updated the event to Team Standup.');
    });

    it('interrupts on update_task and resumes with approval', async () => {
      const interruptibleGraph = workflow.compile({
        checkpointer: new MemorySaver(),
      });

      modelInvokeSpy
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'tool-call-1',
                name: 'update_task',
                args: {
                  taskListId: 'list-1',
                  taskId: 'task-1',
                  title: 'Buy oat milk',
                },
                type: 'tool_call',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(new AIMessage('I renamed the task.'));
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce({
          id: 'task-1',
          title: 'Buy milk',
          status: 'needsAction',
          due: '2026-09-10T00:00:00.000Z',
        })
        .mockResolvedValueOnce({ id: 'list-1', title: 'Groceries' })
        .mockResolvedValueOnce({
          id: 'task-1',
          title: 'Buy milk',
          status: 'needsAction',
          due: '2026-09-10T00:00:00.000Z',
        })
        .mockResolvedValueOnce({ id: 'list-1', title: 'Groceries' })
        .mockResolvedValueOnce({
          id: 'task-1',
          title: 'Buy oat milk',
          status: 'needsAction',
          due: '2026-09-10T00:00:00.000Z',
        });

      const interruptedResult = await interruptibleGraph.invoke(
        { messages: [new HumanMessage('Rename Buy milk to Buy oat milk.')] },
        buildConfig(),
      );

      expect(isInterrupted(interruptedResult)).toBe(true);
      expect(interruptedResult[INTERRUPT][0]?.value).toEqual({
        action: 'update_task',
        description: 'Update "Buy milk": title → "Buy oat milk"',
        current: {
          title: 'Buy milk',
          taskList: 'Groceries',
          due: '2026-09-10',
          status: 'open',
        },
        proposed: {
          title: 'Buy oat milk',
        },
      });

      const resumedResult = await interruptibleGraph.invoke(
        new Command({ resume: 'approve' }),
        buildConfig(),
      );

      expect(isInterrupted(resumedResult)).toBe(false);
      expect(fetchWithAuth).toHaveBeenNthCalledWith(
        5,
        'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Buy oat milk' }),
        },
        'test-access-token',
      );
      expect(modelInvokeSpy).toHaveBeenCalledTimes(2);
      expect(
        resumedResult.messages[resumedResult.messages.length - 1]?.content,
      ).toBe('I renamed the task.');
    });

    it('completes update_task directly when only the status changes', async () => {
      modelInvokeSpy
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'tool-call-1',
                name: 'update_task',
                args: {
                  taskListId: 'list-1',
                  taskId: 'task-1',
                  status: 'completed',
                },
                type: 'tool_call',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(new AIMessage('Done, Buy milk is complete.'));
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce({
          id: 'task-1',
          title: 'Buy milk',
          status: 'needsAction',
        })
        .mockResolvedValueOnce({
          id: 'task-1',
          title: 'Buy milk',
          status: 'completed',
          completed: '2026-01-15T10:00:00.000Z',
        });

      const result = await graph.invoke(
        { messages: [new HumanMessage('Mark Buy milk as done.')] },
        buildConfig(),
      );

      expect(isInterrupted(result)).toBe(false);
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
      expect(fetchWithAuth).toHaveBeenNthCalledWith(
        2,
        'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed' }),
        }),
        'test-access-token',
      );
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        'Done, Buy milk is complete.',
      );
    });
  });
});
