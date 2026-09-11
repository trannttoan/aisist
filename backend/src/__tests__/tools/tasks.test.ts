import { afterEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../../utils/google-api.js';

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
  getTask,
  listTaskLists,
  listTasks,
} from '../../tools/tasks.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
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
