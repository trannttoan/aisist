import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { isValidCalendarDate } from '../utils/date.js';
import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';
import { getAccessToken } from '../utils/tool-config.js';

const GOOGLE_TASKS_API_BASE_URL = 'https://www.googleapis.com/tasks/v1';

type TaskList = {
  id: string;
  title?: string;
};

type ListTaskListsResponse = {
  items?: TaskList[];
  nextPageToken?: string;
};

type Task = {
  id: string;
  title?: string;
  status?: string;
  due?: string;
  notes?: string;
  completed?: string;
  deleted?: boolean;
};

type ListTasksResponse = {
  items?: Task[];
  nextPageToken?: string;
};

// The Tasks API defaults to 20 results per page, low enough that a normal
// account can be silently truncated; 100 is the documented maximum.
const MAX_LIST_RESULTS = 100;

function buildListTaskListsUrl(): string {
  const url = new URL(`${GOOGLE_TASKS_API_BASE_URL}/users/@me/lists`);

  url.searchParams.set('maxResults', String(MAX_LIST_RESULTS));

  return url.toString();
}

function buildListTasksUrl(input: {
  taskListId: string;
  dueMin?: string;
  dueMax?: string;
  showCompleted?: boolean;
}): string {
  const url = new URL(
    `${GOOGLE_TASKS_API_BASE_URL}/lists/${encodeURIComponent(input.taskListId)}/tasks`,
  );

  url.searchParams.set('maxResults', String(MAX_LIST_RESULTS));

  // The API's own default is showCompleted=true, so the open-tasks-only default
  // has to be sent explicitly; cleared tasks additionally need showHidden.
  url.searchParams.set('showCompleted', input.showCompleted ? 'true' : 'false');

  if (input.showCompleted) {
    url.searchParams.set('showHidden', 'true');
  }

  if (input.dueMin) {
    url.searchParams.set('dueMin', `${input.dueMin}T00:00:00.000Z`);
  }

  if (input.dueMax) {
    url.searchParams.set('dueMax', `${input.dueMax}T23:59:59.999Z`);
  }

  return url.toString();
}

function buildGetTaskUrl(taskListId: string, taskId: string): string {
  return `${GOOGLE_TASKS_API_BASE_URL}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`;
}

function formatTaskStatus(task: Task): string {
  return task.status === 'completed' ? 'completed' : 'open';
}

// Google Tasks stores `due` as RFC3339 but discards the time portion.
function formatTaskDueDate(due: string): string {
  return due.split('T')[0];
}

function formatTaskLists(taskLists: TaskList[]): string {
  if (taskLists.length === 0) {
    return 'No task lists found.';
  }

  const lines = taskLists.map((taskList) => {
    const title = taskList.title?.trim() || 'Untitled list';

    return `- ${title} (id: ${taskList.id})`;
  });

  return `Task lists:\n${lines.join('\n')}`;
}

function formatTasks(tasks: Task[]): string {
  if (tasks.length === 0) {
    return 'No tasks found in this list.';
  }

  const lines = tasks.map((task) => {
    const title = task.title?.trim() || 'Untitled task';
    const due = task.due ? `, due ${formatTaskDueDate(task.due)}` : '';
    const notes = task.notes?.trim() ? ', has notes' : '';

    return `- ${title} — ${formatTaskStatus(task)}${due}${notes} (id: ${task.id})`;
  });

  return `Tasks:\n${lines.join('\n')}`;
}

function formatTaskDetail(task: Task): string {
  const title = task.title?.trim() || 'Untitled task';
  const lines = [`Task: ${title}`, `Status: ${formatTaskStatus(task)}`];
  const notes = task.notes?.trim();

  if (task.due) {
    lines.push(`Due: ${formatTaskDueDate(task.due)}`);
  }

  if (notes) {
    lines.push(`Notes: ${notes}`);
  }

  if (task.completed) {
    lines.push(`Completed: ${task.completed}`);
  }

  if (task.deleted) {
    lines.push('Note: this task has been deleted.');
  }

  return lines.join('\n');
}

const listTasksSchema = z
  .object({
    taskListId: z
      .string()
      .trim()
      .min(1)
      .describe('The task list ID to read, obtained from list_task_lists.'),
    dueMin: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Inclusive earliest due date in YYYY-MM-DD format. Google Tasks due dates have no time component.',
      ),
    dueMax: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Inclusive latest due date in YYYY-MM-DD format. Google Tasks due dates have no time component.',
      ),
    showCompleted: z
      .boolean()
      .optional()
      .describe(
        'Include completed and cleared tasks. Defaults to false, which returns open tasks only.',
      ),
  })
  .superRefine((input, ctx) => {
    if (input.dueMin && !isValidCalendarDate(input.dueMin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dueMin "${input.dueMin}" is not a valid calendar date.`,
        path: ['dueMin'],
      });
    }

    if (input.dueMax && !isValidCalendarDate(input.dueMax)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dueMax "${input.dueMax}" is not a valid calendar date.`,
        path: ['dueMax'],
      });
    }

    if (input.dueMin && input.dueMax && input.dueMax < input.dueMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dueMax must not be before dueMin.',
        path: ['dueMax'],
      });
    }
  });

export const listTaskLists = tool(
  async (_input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListTaskListsResponse>(
      buildListTaskListsUrl(),
      {
        method: 'GET',
      },
      accessToken,
    );

    const formatted = formatTaskLists(response?.items ?? []);

    if (response?.nextPageToken) {
      return `${formatted}\n\nNote: only the first ${MAX_LIST_RESULTS} task lists are shown; more exist. Tell the user the list is incomplete.`;
    }

    return formatted;
  },
  {
    name: 'list_task_lists',
    description:
      "List the user's Google Tasks lists. Use this to resolve a task list name to the ID that the other task tools require.",
    schema: z.object({}),
  },
);

export const listTasks = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);

    let response: ListTasksResponse | null;

    try {
      response = await fetchWithAuth<ListTasksResponse>(
        buildListTasksUrl(input),
        {
          method: 'GET',
        },
        accessToken,
      );
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No task list found with ID '${input.taskListId}'.`;
      }

      throw error;
    }

    const formatted = formatTasks(response?.items ?? []);

    if (response?.nextPageToken) {
      return `${formatted}\n\nNote: only the first ${MAX_LIST_RESULTS} tasks are shown; more exist. Tell the user the list is incomplete.`;
    }

    return formatted;
  },
  {
    name: 'list_tasks',
    description:
      "List the tasks in one of the user's Google Tasks lists. Call list_task_lists first to resolve a list name to its ID. Google Tasks due dates are date-only, so due-date filters use YYYY-MM-DD. Returns open tasks only unless showCompleted is true.",
    schema: listTasksSchema,
  },
);

export const getTask = tool(
  async ({ taskListId, taskId }, config) => {
    const accessToken = getAccessToken(config);

    try {
      const task = await fetchWithAuth<Task>(
        buildGetTaskUrl(taskListId, taskId),
        {
          method: 'GET',
        },
        accessToken,
      );

      return formatTaskDetail(task ?? { id: taskId });
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No task found with ID '${taskId}' in this list.`;
      }

      throw error;
    }
  },
  {
    name: 'get_task',
    description:
      "Get the full details for a single task in one of the user's Google Tasks lists, including its notes and completion time.",
    schema: z.object({
      taskListId: z
        .string()
        .trim()
        .min(1)
        .describe('The task list ID, obtained from list_task_lists.'),
      taskId: z
        .string()
        .trim()
        .min(1)
        .describe('The task ID, obtained from list_tasks.'),
    }),
  },
);

export const taskTools = [listTaskLists, listTasks, getTask];
