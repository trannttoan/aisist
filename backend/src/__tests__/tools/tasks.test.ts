import { afterEach, describe, expect, it, vi } from 'vitest';
import { interrupt } from '@langchain/langgraph';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../../utils/google-api.js';

vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>();

  return {
    ...actual,
    interrupt: vi.fn(),
  };
});

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import {
  createTask,
  deleteTask,
  getTask,
  listTaskLists,
  listTasks,
  updateTask,
} from '../../tools/tasks.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(interrupt).mockReset();
});

describe('listTaskLists', () => {
  it('calls the Google Tasks lists endpoint and formats the result', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        { id: 'list-1', title: 'My Tasks' },
        { id: 'list-2', title: 'Groceries' },
      ],
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/users/@me/lists?maxResults=100',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      'Task lists:\n- My Tasks (id: list-1)\n- Groceries (id: list-2)',
    );
  });

  it('falls back to a placeholder title when a list has none', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'list-1', title: '   ' }, { id: 'list-2' }],
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task lists:\n- Untitled list (id: list-1)\n- Untitled list (id: list-2)',
    );
  });

  it('returns an empty-state message when no task lists exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('returns an empty-state message when the response omits items', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({});

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('returns an empty-state message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('appends a truncation note when more task lists exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'list-1', title: 'My Tasks' }],
      nextPageToken: 'next-page',
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task lists:\n- My Tasks (id: list-1)\n\nNote: only the first 100 task lists are shown; more exist. Tell the user the list is incomplete.',
    );
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listTaskLists.invoke({}, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('listTasks', () => {
  it('lists open tasks by default and formats the result', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'task-1',
          title: 'Buy milk',
          status: 'needsAction',
          due: '2026-09-10T00:00:00.000Z',
          notes: 'Semi-skimmed',
        },
        { id: 'task-2', title: 'Call the dentist', status: 'needsAction' },
      ],
    });

    const result = await listTasks.invoke(
      { taskListId: 'list-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks?maxResults=100&showCompleted=false',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      'Tasks:\n- Buy milk — open, due 2026-09-10, has notes (id: task-1)\n- Call the dentist — open (id: task-2)',
    );
  });

  it('falls back to a placeholder title and ignores blank notes', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'task-1', title: '   ', notes: '   ' }],
    });

    const result = await listTasks.invoke(
      { taskListId: 'list-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Tasks:\n- Untitled task — open (id: task-1)');
  });

  it('converts due-date filters to RFC3339 bounds', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    await listTasks.invoke(
      { taskListId: 'list-1', dueMin: '2026-01-01', dueMax: '2026-01-31' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks?maxResults=100&showCompleted=false&dueMin=2026-01-01T00%3A00%3A00.000Z&dueMax=2026-01-31T23%3A59%3A59.999Z',
      { method: 'GET' },
      'token-123',
    );
  });

  it('requests completed and hidden tasks when showCompleted is true', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'task-1',
          title: 'File taxes',
          status: 'completed',
          completed: '2026-09-05T11:22:33.000Z',
        },
      ],
    });

    const result = await listTasks.invoke(
      { taskListId: 'list-1', showCompleted: true },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks?maxResults=100&showCompleted=true&showHidden=true',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe('Tasks:\n- File taxes — completed (id: task-1)');
  });

  it('URI-encodes the task list ID in the path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    await listTasks.invoke(
      { taskListId: 'list/1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list%2F1/tasks?maxResults=100&showCompleted=false',
      { method: 'GET' },
      'token-123',
    );
  });

  it('returns an empty-state message when the list has no tasks', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    const result = await listTasks.invoke(
      { taskListId: 'list-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No tasks found in this list.');
  });

  it('returns an empty-state message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await listTasks.invoke(
      { taskListId: 'list-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No tasks found in this list.');
  });

  it('appends a truncation note when more tasks exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'task-1', title: 'Buy milk' }],
      nextPageToken: 'next-page',
    });

    const result = await listTasks.invoke(
      { taskListId: 'list-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Tasks:\n- Buy milk — open (id: task-1)\n\nNote: only the first 100 tasks are shown; more exist. Tell the user the list is incomplete.',
    );
  });

  it('returns a friendly message when the task list does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(
      new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request failed with status 404.',
        {
          retryable: false,
          status: 404,
        },
      ),
    );

    const result = await listTasks.invoke(
      { taskListId: 'missing-list' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe("No task list found with ID 'missing-list'.");
  });

  it('rejects a due date that is not a real calendar date', async () => {
    await expect(
      listTasks.invoke(
        { taskListId: 'list-1', dueMax: '2026-02-30' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow('dueMax "2026-02-30" is not a valid calendar date.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects a due range that ends before it starts', async () => {
    await expect(
      listTasks.invoke(
        { taskListId: 'list-1', dueMin: '2026-01-31', dueMax: '2026-01-01' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow('dueMax must not be before dueMin.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listTasks.invoke({ taskListId: 'list-1' }, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('getTask', () => {
  it('calls the task detail endpoint and formats every field', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'File taxes',
      status: 'completed',
      due: '2026-04-15T00:00:00.000Z',
      notes: 'Gather receipts first',
      completed: '2026-04-14T18:30:00.000Z',
    });

    const result = await getTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      'Task: File taxes\nStatus: completed\nDue: 2026-04-15\nNotes: Gather receipts first\nCompleted: 2026-04-14T18:30:00.000Z',
    );
  });

  it('omits optional lines for a minimal task', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
    });

    const result = await getTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Task: Buy milk\nStatus: open');
  });

  it('surfaces a deleted task', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
      deleted: true,
    });

    const result = await getTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task: Buy milk\nStatus: open\nNote: this task has been deleted.',
    );
  });

  it('URI-encodes both path segments', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task/1',
      title: 'Buy milk',
    });

    await getTask.invoke(
      { taskListId: 'list/1', taskId: 'task/1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list%2F1/tasks/task%2F1',
      { method: 'GET' },
      'token-123',
    );
  });

  it('returns a friendly message when the task does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(
      new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request failed with status 404.',
        {
          retryable: false,
          status: 404,
        },
      ),
    );

    const result = await getTask.invoke(
      { taskListId: 'list-1', taskId: 'missing-task' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe("No task found with ID 'missing-task' in this list.");
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1' },
        { configurable: {} },
      ),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('createTask', () => {
  it('posts every provided field and formats the created task', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
      due: '2026-09-10T00:00:00.000Z',
      notes: 'Semi-skimmed',
    });

    const result = await createTask.invoke(
      {
        taskListId: 'list-1',
        title: 'Buy milk',
        due: '2026-09-10',
        notes: 'Semi-skimmed',
      },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Buy milk',
          due: '2026-09-10T00:00:00.000Z',
          notes: 'Semi-skimmed',
        }),
      },
      'token-123',
    );
    expect(result).toBe(
      'Task: Buy milk\nStatus: open\nDue: 2026-09-10\nNotes: Semi-skimmed',
    );
  });

  it('omits due and notes from the request body when not provided', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Call the dentist',
    });

    const result = await createTask.invoke(
      { taskListId: 'list-1', title: 'Call the dentist' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Call the dentist' }),
      },
      'token-123',
    );
    expect(result).toBe('Task: Call the dentist\nStatus: open');
  });

  it('URI-encodes the task list ID in the path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
    });

    await createTask.invoke(
      { taskListId: 'list/1', title: 'Buy milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/lists/list%2F1/tasks',
      expect.objectContaining({ method: 'POST' }),
      'token-123',
    );
  });

  it('falls back to placeholder formatting when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await createTask.invoke(
      { taskListId: 'list-1', title: 'Buy milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Task: Untitled task\nStatus: open');
  });

  it('returns a friendly message when the task list does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(
      new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request failed with status 404.',
        {
          retryable: false,
          status: 404,
        },
      ),
    );

    const result = await createTask.invoke(
      { taskListId: 'missing-list', title: 'Buy milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe("No task list found with ID 'missing-list'.");
  });

  it('rejects a due date that is not a real calendar date', async () => {
    await expect(
      createTask.invoke(
        { taskListId: 'list-1', title: 'Buy milk', due: '2026-02-30' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow('due "2026-02-30" is not a valid calendar date.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects a due date that is not in YYYY-MM-DD format', async () => {
    await expect(
      createTask.invoke(
        { taskListId: 'list-1', title: 'Buy milk', due: 'tomorrow' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only title', async () => {
    await expect(
      createTask.invoke(
        { taskListId: 'list-1', title: '   ' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      createTask.invoke(
        { taskListId: 'list-1', title: 'Buy milk' },
        { configurable: {} },
      ),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('updateTask', () => {
  const notFound = new GoogleApiError(
    'GOOGLE_API_REQUEST_FAILED',
    'Google API request failed with status 404.',
    {
      retryable: false,
      status: 404,
    },
  );

  it('marks a task complete directly without interrupting', async () => {
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
        completed: '2026-09-11T10:00:00.000Z',
      });

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', status: 'completed' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'completed' }),
      },
      'token-123',
    );
    expect(result).toBe(
      'Task: Buy milk\nStatus: completed\nCompleted: 2026-09-11T10:00:00.000Z',
    );
  });

  it('reopens a completed task directly and clears the completed timestamp', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'completed',
        completed: '2026-09-11T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
      });

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', status: 'needsAction' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'needsAction', completed: null }),
      },
      'token-123',
    );
    expect(result).toBe('Task: Buy milk\nStatus: open');
  });

  it('returns a no-op message when completing an already completed task', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'completed',
    });

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', status: 'completed' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Task "Buy milk" is already completed.');
    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op message when reopening an open task', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
    });

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', status: 'needsAction' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Task "Buy milk" is already open.');
    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('interrupts for approval, patches the task, and returns formatted details', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
        due: '2026-09-10T00:00:00.000Z',
        notes: 'Semi-skimmed',
      })
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy oat milk',
        status: 'needsAction',
        due: '2026-09-12T00:00:00.000Z',
        notes: 'Barista edition',
      });
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await updateTask.invoke(
      {
        taskListId: 'list-1',
        taskId: 'task-1',
        title: 'Buy oat milk',
        due: '2026-09-12',
        notes: 'Barista edition',
      },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).toHaveBeenCalledWith({
      action: 'update_task',
      description:
        'Update "Buy milk": title → "Buy oat milk", due → 2026-09-12, notes updated',
      current: {
        taskId: 'task-1',
        taskListId: 'list-1',
        title: 'Buy milk',
        notes: 'Semi-skimmed',
        due: '2026-09-10',
        status: 'open',
      },
      proposed: {
        title: 'Buy oat milk',
        due: '2026-09-12',
        notes: 'Barista edition',
      },
    });
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      { method: 'GET' },
      'token-123',
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Buy oat milk',
          notes: 'Barista edition',
          due: '2026-09-12T00:00:00.000Z',
        }),
      },
      'token-123',
    );
    expect(result).toBe(
      'Task: Buy oat milk\nStatus: open\nDue: 2026-09-12\nNotes: Barista edition',
    );
  });

  it('interrupts when status is combined with other fields', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
      })
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk (done)',
        status: 'completed',
      });
    vi.mocked(interrupt).mockReturnValue('approve');

    await updateTask.invoke(
      {
        taskListId: 'list-1',
        taskId: 'task-1',
        title: 'Buy milk (done)',
        status: 'completed',
      },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).toHaveBeenCalledWith({
      action: 'update_task',
      description:
        'Update "Buy milk": title → "Buy milk (done)", status → completed',
      current: {
        taskId: 'task-1',
        taskListId: 'list-1',
        title: 'Buy milk',
        status: 'open',
      },
      proposed: {
        title: 'Buy milk (done)',
        status: 'completed',
      },
    });
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Buy milk (done)', status: 'completed' }),
      }),
      'token-123',
    );
  });

  it('returns a cancellation message when the update is rejected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
    });
    vi.mocked(interrupt).mockReturnValue('reject');

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', title: 'Buy oat milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Update cancelled.');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a friendly message without interrupting when the task does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(notFound);

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'missing-task', title: 'Buy oat milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe("No task found with ID 'missing-task' in this list.");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('returns a deleted-task message without interrupting or patching', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
      deleted: true,
    });

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', status: 'completed' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task "Buy milk" has been deleted, so it cannot be updated.',
    );
    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a friendly message when the task disappears between interrupt and resume', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
      })
      .mockRejectedValueOnce(notFound);
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', title: 'Buy oat milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).toHaveBeenCalled();
    expect(result).toBe(
      "No task found with ID 'task-1' in this list. It may no longer exist.",
    );
  });

  it('reports an unverified update when the patch response body is empty', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
      })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await updateTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1', title: 'Buy oat milk' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      "The update request for task 'task-1' completed, but Google did not return the updated task. Ask the user to verify the change in Google Tasks.",
    );
  });

  it('URI-encodes both path segments', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task/1',
      title: 'Buy milk',
      status: 'needsAction',
    });

    await updateTask.invoke(
      { taskListId: 'list/1', taskId: 'task/1', status: 'completed' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list%2F1/tasks/task%2F1',
      expect.objectContaining({ method: 'PATCH' }),
      'token-123',
    );
  });

  it('rejects when no update fields are provided', async () => {
    await expect(
      updateTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow('Provide at least one field to update.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('rejects a due date that is not a real calendar date', async () => {
    await expect(
      updateTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1', due: '2026-02-30' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow('due "2026-02-30" is not a valid calendar date.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects an unknown status value', async () => {
    await expect(
      updateTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1', status: 'done' },
        { configurable: { access_token: 'token-123' } },
      ),
    ).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      updateTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1', status: 'completed' },
        { configurable: {} },
      ),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('deleteTask', () => {
  const notFound = new GoogleApiError(
    'GOOGLE_API_REQUEST_FAILED',
    'Google API request failed with status 404.',
    {
      retryable: false,
      status: 404,
    },
  );

  it('interrupts for approval, deletes the task, and returns a confirmation', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
        due: '2026-09-10T00:00:00.000Z',
        notes: 'Semi-skimmed',
      })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await deleteTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).toHaveBeenCalledWith({
      action: 'delete_task',
      description: 'Delete "Buy milk".',
      current: {
        taskId: 'task-1',
        taskListId: 'list-1',
        title: 'Buy milk',
        notes: 'Semi-skimmed',
        due: '2026-09-10',
        status: 'open',
      },
      proposed: null,
    });
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      { method: 'GET' },
      'token-123',
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list-1/tasks/task-1',
      { method: 'DELETE' },
      'token-123',
    );
    expect(result).toBe('Deleted "Buy milk".');
  });

  it('returns a cancellation message when the deletion is rejected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
    });
    vi.mocked(interrupt).mockReturnValue('reject');

    const result = await deleteTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Deletion cancelled.');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns an already-deleted message without interrupting', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'task-1',
      title: 'Buy milk',
      status: 'needsAction',
      deleted: true,
    });

    const result = await deleteTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('Task "Buy milk" has already been deleted.');
    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a friendly message without interrupting when the task does not exist', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(notFound);

    const result = await deleteTask.invoke(
      { taskListId: 'list-1', taskId: 'missing-task' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe("No task found with ID 'missing-task' in this list.");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('returns a friendly message when the task disappears between interrupt and resume', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'task-1',
        title: 'Buy milk',
        status: 'needsAction',
      })
      .mockRejectedValueOnce(notFound);
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await deleteTask.invoke(
      { taskListId: 'list-1', taskId: 'task-1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(interrupt).toHaveBeenCalled();
    expect(result).toBe(
      "No task found with ID 'task-1' in this list. It may no longer exist.",
    );
  });

  it('URI-encodes both path segments', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({ id: 'task/1', title: 'Buy milk' })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    await deleteTask.invoke(
      { taskListId: 'list/1', taskId: 'task/1' },
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/tasks/v1/lists/list%2F1/tasks/task%2F1',
      { method: 'DELETE' },
      'token-123',
    );
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      deleteTask.invoke(
        { taskListId: 'list-1', taskId: 'task-1' },
        { configurable: {} },
      ),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });
});
