import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

import { isValidCalendarDate } from '../utils/date.js';
import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';
import { getAccessToken } from '../utils/tool-config.js';

const GOOGLE_CALENDAR_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';

type CalendarEventDateTime = {
  date?: string;
  dateTime?: string;
};

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  recurringEventId?: string;
};

type CalendarEventAttendee = {
  email?: string;
};

type DetailedCalendarEvent = CalendarEvent & {
  description?: string;
  attendees?: CalendarEventAttendee[];
  recurrence?: string[];
  status?: string;
  htmlLink?: string;
};

type CreateCalendarEventInput = {
  summary: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  attendees?: string[];
};

type UpdateCalendarEventInput = {
  eventId: string;
  recurringEventScope?: 'single' | 'all';
  summary?: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  attendees?: string[];
};

type DeleteCalendarEventInput = {
  eventId: string;
  recurringEventScope?: 'single' | 'all';
};

type CreateCalendarEventRequestBody = {
  summary: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string }>;
};

type UpdateCalendarEventRequestBody = {
  summary?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string }>;
};

type ListCalendarEventsResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

const MAX_LIST_RESULTS = 250;

// Google answers 404 for an unknown event and 410 for one that has already
// been deleted; both mean the same thing to the user.
function isMissingResourceStatus(error: GoogleApiError): boolean {
  return error.status === 404 || error.status === 410;
}

function buildListCalendarEventsUrl(input: {
  timeMin?: string;
  timeMax?: string;
  query?: string;
}): string {
  const url = new URL(
    `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events`,
  );

  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(MAX_LIST_RESULTS));

  if (input.timeMin) {
    url.searchParams.set('timeMin', input.timeMin);
  }

  if (input.timeMax) {
    url.searchParams.set('timeMax', input.timeMax);
  }

  if (input.query) {
    url.searchParams.set('q', input.query);
  }

  return url.toString();
}

function buildGetCalendarEventUrl(eventId: string): string {
  return `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`;
}

function buildCreateCalendarEventUrl(): string {
  return `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events`;
}

function buildUpdateCalendarEventUrl(eventId: string): string {
  return `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`;
}

function buildDeleteCalendarEventUrl(eventId: string): string {
  return `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`;
}

function exclusiveEndToInclusive(exclusiveEnd: string): string {
  const date = new Date(exclusiveEnd + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function inclusiveEndToExclusive(inclusiveEnd: string): string {
  const date = new Date(inclusiveEnd + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatEventDateRange(event: CalendarEvent): string {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;

  if (event.start?.date && !event.start.dateTime) {
    if (!end) {
      return `${start} (all day)`;
    }
    const inclusiveEnd = exclusiveEndToInclusive(end);
    return inclusiveEnd === start
      ? `${start} (all day)`
      : `${start} to ${inclusiveEnd} (all day)`;
  }

  if (start && end) {
    return `${start} to ${end}`;
  }

  if (start) {
    return start;
  }

  return 'time unavailable';
}

function formatCalendarEvents(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'No calendar events found.';
  }

  const lines = events.map((event) => {
    const summary = event.summary?.trim() || 'Untitled event';
    const location = event.location?.trim()
      ? ` @ ${event.location.trim()}`
      : '';

    const recurring = event.recurringEventId ? ', recurring' : '';

    return `- ${formatEventDateRange(event)} — ${summary}${location} (id: ${event.id}${recurring})`;
  });

  return `Calendar events:\n${lines.join('\n')}`;
}

function formatEventDetail(event: DetailedCalendarEvent): string {
  const summary = event.summary?.trim() || 'Untitled event';
  const lines = [`Event: ${summary}`, `When: ${formatEventDateRange(event)}`];
  const location = event.location?.trim();
  const description = event.description?.trim();
  const attendeeEmails =
    event.attendees
      ?.map((attendee) => attendee.email?.trim())
      .filter((email): email is string => Boolean(email)) ?? [];
  const status = event.status?.trim();
  const htmlLink = event.htmlLink?.trim();

  if (location) {
    lines.push(`Location: ${location}`);
  }

  if (description) {
    lines.push(`Description: ${description}`);
  }

  if (attendeeEmails.length > 0) {
    lines.push(`Attendees: ${attendeeEmails.join(', ')}`);
  }

  if (event.recurringEventId || event.recurrence?.length) {
    lines.push('Recurring: yes');
  }

  if (status) {
    lines.push(`Status: ${status}`);
  }

  if (htmlLink) {
    lines.push(`Link: ${htmlLink}`);
  }

  return lines.join('\n');
}

function buildEventRequestBody(
  input: CreateCalendarEventInput,
): CreateCalendarEventRequestBody {
  const body: CreateCalendarEventRequestBody = {
    summary: input.summary.trim(),
    start: input.startDateTime
      ? { dateTime: input.startDateTime }
      : { date: input.startDate! },
    end: input.endDateTime
      ? { dateTime: input.endDateTime }
      : {
          date: inclusiveEndToExclusive(input.endDate ?? input.startDate!),
        },
  };

  const location = input.location?.trim();
  const description = input.description?.trim();
  const attendees =
    input.attendees
      ?.map((email) => email.trim())
      .filter((email) => email.length > 0)
      .map((email) => ({ email })) ?? [];

  if (location) {
    body.location = location;
  }

  if (description) {
    body.description = description;
  }

  if (attendees.length > 0) {
    body.attendees = attendees;
  }

  return body;
}

function buildUpdateEventRequestBody(
  input: UpdateCalendarEventInput,
): UpdateCalendarEventRequestBody {
  const body: UpdateCalendarEventRequestBody = {};
  const summary = input.summary?.trim();
  const location = input.location?.trim();
  const description = input.description?.trim();

  if (summary) {
    body.summary = summary;
  }

  if (input.startDateTime) {
    body.start = { dateTime: input.startDateTime };
  } else if (input.startDate) {
    body.start = { date: input.startDate };
  }

  if (input.endDateTime) {
    body.end = { dateTime: input.endDateTime };
  } else if (input.endDate) {
    body.end = { date: inclusiveEndToExclusive(input.endDate) };
  }

  if (location) {
    body.location = location;
  }

  if (description) {
    body.description = description;
  }

  if (input.attendees !== undefined) {
    body.attendees = input.attendees
      .map((email) => email.trim())
      .filter((email) => email.length > 0)
      .map((email) => ({ email }));
  }

  return body;
}

function toEventSnapshot(event: DetailedCalendarEvent): {
  eventId: string;
  recurringEventId?: string;
  summary?: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  attendees?: string[];
} {
  const attendeeEmails =
    event.attendees
      ?.map((attendee) => attendee.email?.trim())
      .filter((email): email is string => Boolean(email)) ?? [];

  return {
    eventId: event.id,
    recurringEventId: event.recurringEventId,
    summary: event.summary?.trim(),
    startDateTime: event.start?.dateTime,
    endDateTime: event.end?.dateTime,
    startDate: event.start?.date,
    endDate:
      event.start?.date && event.end?.date
        ? exclusiveEndToInclusive(event.end.date)
        : undefined,
    location: event.location?.trim(),
    description: event.description?.trim(),
    attendees: attendeeEmails.length > 0 ? attendeeEmails : undefined,
  };
}

function toProposedUpdateSnapshot(input: UpdateCalendarEventInput): Omit<
  ReturnType<typeof toEventSnapshot>,
  'eventId' | 'recurringEventId'
> & {
  recurringEventScope?: 'single' | 'all';
} {
  const proposed: Omit<
    ReturnType<typeof toEventSnapshot>,
    'eventId' | 'recurringEventId'
  > & { recurringEventScope?: 'single' | 'all' } = {};

  if (input.recurringEventScope) {
    proposed.recurringEventScope = input.recurringEventScope;
  }

  if (input.summary) {
    proposed.summary = input.summary.trim();
  }

  if (input.startDateTime) {
    proposed.startDateTime = input.startDateTime;
  }

  if (input.endDateTime) {
    proposed.endDateTime = input.endDateTime;
  }

  if (input.startDate) {
    proposed.startDate = input.startDate;
  }

  if (input.endDate) {
    proposed.endDate = input.endDate;
  }

  if (input.location) {
    proposed.location = input.location.trim();
  }

  if (input.description) {
    proposed.description = input.description.trim();
  }

  if (input.attendees !== undefined) {
    proposed.attendees = input.attendees
      .map((email) => email.trim())
      .filter((email) => email.length > 0);
  }

  return proposed;
}

function buildUpdateDescription(
  currentEvent: DetailedCalendarEvent,
  proposed: ReturnType<typeof toProposedUpdateSnapshot>,
): string {
  const currentSummary = currentEvent.summary?.trim() || 'Untitled event';
  const scopeLabel =
    proposed.recurringEventScope === 'all' && currentEvent.recurringEventId
      ? ' (all instances)'
      : '';
  const changes: string[] = [];

  if (proposed.summary) {
    changes.push(`summary → "${proposed.summary}"`);
  }

  if (proposed.startDateTime) {
    changes.push(`start → ${proposed.startDateTime}`);
  }

  if (proposed.endDateTime) {
    changes.push(`end → ${proposed.endDateTime}`);
  }

  if (proposed.startDate) {
    changes.push(`start date → ${proposed.startDate}`);
  }

  if (proposed.endDate) {
    changes.push(`end date → ${proposed.endDate}`);
  }

  if (proposed.location) {
    changes.push(`location → "${proposed.location}"`);
  }

  if (proposed.description) {
    changes.push('description updated');
  }

  if (proposed.attendees) {
    changes.push(
      proposed.attendees.length > 0
        ? `attendees → ${proposed.attendees.join(', ')}`
        : 'attendees cleared',
    );
  }

  return changes.length > 0
    ? `Update "${currentSummary}"${scopeLabel}: ${changes.join(', ')}`
    : `Update "${currentSummary}"${scopeLabel}.`;
}

function buildDeleteDescription(
  currentEvent: DetailedCalendarEvent,
  scope: DeleteCalendarEventInput['recurringEventScope'],
): string {
  const currentSummary = currentEvent.summary?.trim() || 'Untitled event';
  const scopeLabel =
    scope === 'all' && currentEvent.recurringEventId ? ' (all instances)' : '';

  return `Delete "${currentSummary}"${scopeLabel}.`;
}

const createCalendarEventSchema = z
  .object({
    summary: z.string().trim().min(1).describe('The event title or summary.'),
    startDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('RFC3339 start time for a timed event.'),
    endDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('RFC3339 end time for a timed event.'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Start date for an all-day event in YYYY-MM-DD format.'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Inclusive end date for an all-day event in YYYY-MM-DD format.',
      ),
    location: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional event location.'),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional event description.'),
    attendees: z
      .array(z.string().trim().email())
      .optional()
      .describe('Optional attendee email addresses.'),
  })
  .superRefine((input, ctx) => {
    const hasTimedInput = Boolean(input.startDateTime || input.endDateTime);
    const hasAllDayInput = Boolean(input.startDate || input.endDate);

    if (!input.startDateTime && !input.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either startDateTime for a timed event or startDate for an all-day event.',
        path: ['startDateTime'],
      });
    }

    if (hasTimedInput && hasAllDayInput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Timed event fields and all-day event fields cannot be combined.',
        path: ['startDateTime'],
      });
    }

    if (input.startDateTime && !input.endDateTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDateTime is required when startDateTime is provided.',
        path: ['endDateTime'],
      });
    }

    if (input.endDateTime && !input.startDateTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startDateTime is required when endDateTime is provided.',
        path: ['startDateTime'],
      });
    }

    if (input.endDate && !input.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startDate is required when endDate is provided.',
        path: ['startDate'],
      });
    }

    if (input.startDate && !isValidCalendarDate(input.startDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `startDate "${input.startDate}" is not a valid calendar date.`,
        path: ['startDate'],
      });
    }

    if (input.endDate && !isValidCalendarDate(input.endDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `endDate "${input.endDate}" is not a valid calendar date.`,
        path: ['endDate'],
      });
    }

    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate must not be before startDate.',
        path: ['endDate'],
      });
    }

    if (
      input.startDateTime &&
      input.endDateTime &&
      Date.parse(input.endDateTime) <= Date.parse(input.startDateTime)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDateTime must be after startDateTime.',
        path: ['endDateTime'],
      });
    }
  });

const updateCalendarEventSchema = z
  .object({
    eventId: z
      .string()
      .trim()
      .min(1)
      .describe('The Google Calendar event ID to update.'),
    recurringEventScope: z
      .enum(['single', 'all'])
      .optional()
      .describe(
        'For recurring events, update only this instance or the whole series.',
      ),
    summary: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Updated event title or summary.'),
    startDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Updated RFC3339 start time for a timed event.'),
    endDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Updated RFC3339 end time for a timed event.'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Updated start date for an all-day event in YYYY-MM-DD format.',
      ),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Updated inclusive end date for an all-day event in YYYY-MM-DD format.',
      ),
    location: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Updated event location.'),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Updated event description.'),
    attendees: z
      .array(z.string().trim().email())
      .optional()
      .describe('Updated attendee email addresses.'),
  })
  .superRefine((input, ctx) => {
    const hasTimedInput = Boolean(input.startDateTime || input.endDateTime);
    const hasAllDayInput = Boolean(input.startDate || input.endDate);
    const hasUpdateFields =
      input.summary !== undefined ||
      input.startDateTime !== undefined ||
      input.endDateTime !== undefined ||
      input.startDate !== undefined ||
      input.endDate !== undefined ||
      input.location !== undefined ||
      input.description !== undefined ||
      input.attendees !== undefined;

    if (!hasUpdateFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one field to update.',
        path: ['eventId'],
      });
    }

    if (hasTimedInput && hasAllDayInput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Timed event fields and all-day event fields cannot be combined.',
        path: ['startDateTime'],
      });
    }

    if (input.startDate && !isValidCalendarDate(input.startDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `startDate "${input.startDate}" is not a valid calendar date.`,
        path: ['startDate'],
      });
    }

    if (input.endDate && !isValidCalendarDate(input.endDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `endDate "${input.endDate}" is not a valid calendar date.`,
        path: ['endDate'],
      });
    }

    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate must not be before startDate.',
        path: ['endDate'],
      });
    }

    if (
      input.startDateTime &&
      input.endDateTime &&
      Date.parse(input.endDateTime) <= Date.parse(input.startDateTime)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDateTime must be after startDateTime.',
        path: ['endDateTime'],
      });
    }
  });

const deleteCalendarEventSchema = z.object({
  eventId: z
    .string()
    .trim()
    .min(1)
    .describe('The Google Calendar event ID to delete.'),
  recurringEventScope: z
    .enum(['single', 'all'])
    .optional()
    .describe(
      'For recurring events, delete only this instance or the whole series.',
    ),
});

export const listCalendarEvents = tool(
  async ({ timeMin, timeMax, query }, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListCalendarEventsResponse>(
      buildListCalendarEventsUrl({ timeMin, timeMax, query }),
      {
        method: 'GET',
      },
      accessToken,
    );

    const formatted = formatCalendarEvents(response?.items ?? []);

    if (response?.nextPageToken) {
      return `${formatted}\n\nNote: only the first ${MAX_LIST_RESULTS} events are shown; more events exist in this range. Tell the user the list is incomplete, and narrow the time range or add a search query to see the rest.`;
    }

    return formatted;
  },
  {
    name: 'list_calendar_events',
    description:
      "List events from the user's primary Google Calendar within an optional time range or search query.",
    schema: z.object({
      timeMin: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Inclusive RFC3339 lower bound for event start times.'),
      timeMax: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Exclusive RFC3339 upper bound for event start times.'),
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Free-text search query for matching event details.'),
    }),
  },
);

export const getCalendarEvent = tool(
  async ({ eventId }, config) => {
    const accessToken = getAccessToken(config);

    try {
      const event = await fetchWithAuth<DetailedCalendarEvent>(
        buildGetCalendarEventUrl(eventId),
        {
          method: 'GET',
        },
        accessToken,
      );

      return formatEventDetail(
        event ?? {
          id: eventId,
        },
      );
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No event found with ID '${eventId}'.`;
      }

      throw error;
    }
  },
  {
    name: 'get_calendar_event',
    description:
      "Get the details for a single event from the user's primary Google Calendar.",
    schema: z.object({
      eventId: z
        .string()
        .trim()
        .min(1)
        .describe('The Google Calendar event ID to fetch.'),
    }),
  },
);

export const createCalendarEvent = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    const event = await fetchWithAuth<DetailedCalendarEvent>(
      buildCreateCalendarEventUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildEventRequestBody(input)),
      },
      accessToken,
    );

    return formatEventDetail(
      event ?? {
        id: 'created-event',
      },
    );
  },
  {
    name: 'create_calendar_event',
    description:
      "Create a timed or all-day event in the user's primary Google Calendar.",
    schema: createCalendarEventSchema,
  },
);

export const updateCalendarEvent = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);

    let currentEvent: DetailedCalendarEvent;

    try {
      currentEvent = (await fetchWithAuth<DetailedCalendarEvent>(
        buildGetCalendarEventUrl(input.eventId),
        {
          method: 'GET',
        },
        accessToken,
      )) ?? { id: input.eventId };
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No event found with ID '${input.eventId}'.`;
      }

      throw error;
    }

    if (currentEvent.status === 'cancelled') {
      return `Event '${input.eventId}' has been deleted, so it cannot be updated.`;
    }

    const proposed = toProposedUpdateSnapshot(input);
    const decision = interrupt<
      {
        action: 'update_calendar_event';
        description: string;
        current: ReturnType<typeof toEventSnapshot>;
        proposed: typeof proposed;
      },
      'approve' | 'reject'
    >({
      action: 'update_calendar_event',
      description: buildUpdateDescription(currentEvent, proposed),
      current: toEventSnapshot(currentEvent),
      proposed,
    });

    if (decision !== 'approve') {
      return 'Update cancelled.';
    }

    const targetEventId =
      input.recurringEventScope === 'all' && currentEvent.recurringEventId
        ? currentEvent.recurringEventId
        : input.eventId;

    let event: DetailedCalendarEvent | null;

    try {
      event = await fetchWithAuth<DetailedCalendarEvent>(
        buildUpdateCalendarEventUrl(targetEventId),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildUpdateEventRequestBody(input)),
        },
        accessToken,
      );
    } catch (error) {
      if (error instanceof GoogleApiError && isMissingResourceStatus(error)) {
        return `No event found with ID '${targetEventId}'. It may no longer exist.`;
      }

      throw error;
    }

    if (!event) {
      return `The update request for event '${targetEventId}' completed, but Google did not return the updated event. Ask the user to verify the change in their calendar.`;
    }

    return formatEventDetail(event);
  },
  {
    name: 'update_calendar_event',
    description:
      "Update an existing event in the user's primary Google Calendar. Requires user approval.",
    schema: updateCalendarEventSchema,
  },
);

export const deleteCalendarEvent = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);

    let currentEvent: DetailedCalendarEvent;

    try {
      currentEvent = (await fetchWithAuth<DetailedCalendarEvent>(
        buildGetCalendarEventUrl(input.eventId),
        {
          method: 'GET',
        },
        accessToken,
      )) ?? { id: input.eventId };
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No event found with ID '${input.eventId}'.`;
      }

      throw error;
    }

    if (currentEvent.status === 'cancelled') {
      const summary = currentEvent.summary?.trim() || 'Untitled event';
      return `Event "${summary}" has already been deleted.`;
    }

    const decision = interrupt<
      {
        action: 'delete_calendar_event';
        description: string;
        current: ReturnType<typeof toEventSnapshot>;
        proposed: null;
      },
      'approve' | 'reject'
    >({
      action: 'delete_calendar_event',
      description: buildDeleteDescription(
        currentEvent,
        input.recurringEventScope,
      ),
      current: toEventSnapshot(currentEvent),
      proposed: null,
    });

    if (decision !== 'approve') {
      return 'Deletion cancelled.';
    }

    const targetEventId =
      input.recurringEventScope === 'all' && currentEvent.recurringEventId
        ? currentEvent.recurringEventId
        : input.eventId;

    try {
      await fetchWithAuth(
        buildDeleteCalendarEventUrl(targetEventId),
        {
          method: 'DELETE',
        },
        accessToken,
      );
    } catch (error) {
      if (error instanceof GoogleApiError && isMissingResourceStatus(error)) {
        return `No event found with ID '${targetEventId}'. It may no longer exist.`;
      }

      throw error;
    }

    const summary = currentEvent.summary?.trim() || 'Untitled event';
    const scopeLabel =
      input.recurringEventScope === 'all' && currentEvent.recurringEventId
        ? ' (all instances)'
        : '';

    return `Deleted "${summary}"${scopeLabel}.`;
  },
  {
    name: 'delete_calendar_event',
    description:
      "Delete an event from the user's primary Google Calendar. Requires user approval.",
    schema: deleteCalendarEventSchema,
  },
);

export const calendarTools = [
  listCalendarEvents,
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
];
