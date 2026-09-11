import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
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

function buildTaskUrl(taskListId: string, taskId: string): string {
  return `${GOOGLE_TASKS_API_BASE_URL}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`;
}

function buildCreateTaskUrl(taskListId: string): string {
  return `${GOOGLE_TASKS_API_BASE_URL}/lists/${encodeURIComponent(taskListId)}/tasks`;
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

const createTaskSchema = z
  .object({
    taskListId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The task list ID to create the task in, obtained from list_task_lists or asked of the user; '@default' targets the default list.",
      ),
    title: z.string().trim().min(1).describe('The task title.'),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Optional due date in YYYY-MM-DD format. Google Tasks has no due times, so never promise the user a time of day.',
      ),
    notes: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional free-text notes for the task.'),
  })
  .superRefine((input, ctx) => {
    if (input.due && !isValidCalendarDate(input.due)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `due "${input.due}" is not a valid calendar date.`,
        path: ['due'],
      });
    }
  });

function buildCreateTaskRequestBody(
  input: z.infer<typeof createTaskSchema>,
): Record<string, string> {
  const body: Record<string, string> = { title: input.title };

  if (input.due) {
    body.due = `${input.due}T00:00:00.000Z`;
  }

  if (input.notes) {
    body.notes = input.notes;
  }

  return body;
}

const updateTaskSchema = z
  .object({
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
    title: z.string().trim().min(1).optional().describe('Updated task title.'),
    notes: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Updated free-text notes for the task.'),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Updated due date in YYYY-MM-DD format. Google Tasks has no due times, so never promise the user a time of day.',
      ),
    status: z
      .enum(['needsAction', 'completed'])
      .optional()
      .describe(
        'completed marks the task done; needsAction reopens it. A status-only update executes without user approval.',
      ),
  })
  .superRefine((input, ctx) => {
    const hasUpdateFields =
      input.title !== undefined ||
      input.notes !== undefined ||
      input.due !== undefined ||
      input.status !== undefined;

    if (!hasUpdateFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one field to update.',
        path: ['taskId'],
      });
    }

    if (input.due && !isValidCalendarDate(input.due)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `due "${input.due}" is not a valid calendar date.`,
        path: ['due'],
      });
    }
  });

type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

type TaskSnapshot = {
  taskId: string;
  taskListId: string;
  title: string;
  due?: string;
  notes?: string;
  status: string;
};

type ProposedTaskUpdate = Partial<
  Pick<TaskSnapshot, 'title' | 'notes' | 'due' | 'status'>
>;

function isStatusOnlyUpdate(input: UpdateTaskInput): boolean {
  return (
    input.status !== undefined &&
    input.title === undefined &&
    input.notes === undefined &&
    input.due === undefined
  );
}

function buildUpdateTaskRequestBody(
  input: UpdateTaskInput,
): Record<string, string | null> {
  const body: Record<string, string | null> = {};

  if (input.title) {
    body.title = input.title;
  }

  if (input.notes) {
    body.notes = input.notes;
  }

  if (input.due) {
    body.due = `${input.due}T00:00:00.000Z`;
  }

  if (input.status) {
    body.status = input.status;
  }

  // Reopening a task must also clear its completion timestamp, or Google
  // keeps reporting it as completed.
  if (input.status === 'needsAction') {
    body.completed = null;
  }

  return body;
}

function toTaskSnapshot(task: Task, taskListId: string): TaskSnapshot {
  return {
    taskId: task.id,
    taskListId,
    title: task.title?.trim() || 'Untitled task',
    due: task.due ? formatTaskDueDate(task.due) : undefined,
    notes: task.notes?.trim() || undefined,
    status: formatTaskStatus(task),
  };
}

function toProposedTaskUpdate(input: UpdateTaskInput): ProposedTaskUpdate {
  const proposed: ProposedTaskUpdate = {};

  if (input.title) {
    proposed.title = input.title;
  }

  if (input.due) {
    proposed.due = input.due;
  }

  if (input.notes) {
    proposed.notes = input.notes;
  }

  if (input.status) {
    proposed.status = input.status === 'completed' ? 'completed' : 'open';
  }

  return proposed;
}

function buildUpdateTaskDescription(
  currentTask: Task,
  proposed: ProposedTaskUpdate,
): string {
  const currentTitle = currentTask.title?.trim() || 'Untitled task';
  const changes: string[] = [];

  if (proposed.title) {
    changes.push(`title → "${proposed.title}"`);
  }

  if (proposed.due) {
    changes.push(`due → ${proposed.due}`);
  }

  if (proposed.notes) {
    changes.push('notes updated');
  }

  if (proposed.status) {
    changes.push(`status → ${proposed.status}`);
  }

  return `Update "${currentTitle}": ${changes.join(', ')}`;
}

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
        buildTaskUrl(taskListId, taskId),
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

export const createTask = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);

    try {
      const task = await fetchWithAuth<Task>(
        buildCreateTaskUrl(input.taskListId),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildCreateTaskRequestBody(input)),
        },
        accessToken,
      );

      return formatTaskDetail(task ?? { id: 'created-task' });
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No task list found with ID '${input.taskListId}'.`;
      }

      throw error;
    }
  },
  {
    name: 'create_task',
    description:
      "Create a task in one of the user's Google Tasks lists. Call list_task_lists first to resolve a list name to its ID, or ask the user which list to use. Google Tasks due dates are date-only, so due takes YYYY-MM-DD and the task has no due time.",
    schema: createTaskSchema,
  },
);

export const updateTask = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    const { taskListId, taskId } = input;

    let currentTask: Task;

    try {
      currentTask = (await fetchWithAuth<Task>(
        buildTaskUrl(taskListId, taskId),
        {
          method: 'GET',
        },
        accessToken,
      )) ?? { id: taskId };
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No task found with ID '${taskId}' in this list.`;
      }

      throw error;
    }

    const currentTitle = currentTask.title?.trim() || 'Untitled task';

    if (currentTask.deleted) {
      return `Task "${currentTitle}" has been deleted, so it cannot be updated.`;
    }

    if (isStatusOnlyUpdate(input)) {
      const isCompleted = currentTask.status === 'completed';

      if (input.status === 'completed' && isCompleted) {
        return `Task "${currentTitle}" is already completed.`;
      }

      if (input.status === 'needsAction' && !isCompleted) {
        return `Task "${currentTitle}" is already open.`;
      }
    } else {
      const proposed = toProposedTaskUpdate(input);
      const decision = interrupt<
        {
          action: 'update_task';
          description: string;
          current: TaskSnapshot;
          proposed: ProposedTaskUpdate;
        },
        'approve' | 'reject'
      >({
        action: 'update_task',
        description: buildUpdateTaskDescription(currentTask, proposed),
        current: toTaskSnapshot(currentTask, taskListId),
        proposed,
      });

      if (decision !== 'approve') {
        return 'Update cancelled.';
      }
    }

    let task: Task | null;

    try {
      task = await fetchWithAuth<Task>(
        buildTaskUrl(taskListId, taskId),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildUpdateTaskRequestBody(input)),
        },
        accessToken,
      );
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No task found with ID '${taskId}' in this list. It may no longer exist.`;
      }

      throw error;
    }

    if (!task) {
      return `The update request for task '${taskId}' completed, but Google did not return the updated task. Ask the user to verify the change in Google Tasks.`;
    }

    return formatTaskDetail(task);
  },
  {
    name: 'update_task',
    description:
      "Update a task in one of the user's Google Tasks lists: title, notes, due date (YYYY-MM-DD, no due times), or status. Requires user approval unless only the status changes (marking complete or reopening), which executes directly.",
    schema: updateTaskSchema,
  },
);

export const taskTools = [
  listTaskLists,
  listTasks,
  getTask,
  createTask,
  updateTask,
];
