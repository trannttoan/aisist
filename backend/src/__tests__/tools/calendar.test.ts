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
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from '../../tools/calendar.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(interrupt).mockReset();
});

describe('listCalendarEvents', () => {
  it('calls the Google Calendar events endpoint with the expected query params', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'event-1',
          summary: 'Team Sync',
          location: 'Conference Room',
          start: { dateTime: '2026-01-16T09:00:00-05:00' },
          end: { dateTime: '2026-01-16T09:30:00-05:00' },
        },
        {
          id: 'event-2',
          summary: 'Offsite',
          start: { date: '2026-01-17' },
          end: { date: '2026-01-18' },
        },
        {
          id: 'event-3_20260118T140000Z',
          summary: 'Daily Standup',
          recurringEventId: 'event-3',
          start: { dateTime: '2026-01-18T09:00:00-05:00' },
          end: { dateTime: '2026-01-18T09:15:00-05:00' },
        },
      ],
    });

    const result = await listCalendarEvents.invoke(
      {
        timeMin: '2026-01-16T00:00:00-05:00',
        timeMax: '2026-01-18T00:00:00-05:00',
        query: 'team',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Calendar events:');
    expect(result).toContain('Team Sync @ Conference Room (id: event-1)');
    expect(result).toContain('2026-01-17 (all day)');
    expect(result).toContain('(id: event-2)');
    expect(result).toContain(
      'Daily Standup (id: event-3_20260118T140000Z, recurring)',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=2026-01-16T00%3A00%3A00-05%3A00&timeMax=2026-01-18T00%3A00%3A00-05%3A00&q=team',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
  });

  it('returns a friendly empty state when no events are found', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    await expect(
      listCalendarEvents.invoke(
        {},
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('No calendar events found.');
  });

  it('appends a truncation notice when the response has more pages', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'event-1',
          summary: 'Team Sync',
          start: { dateTime: '2026-01-16T09:00:00-05:00' },
          end: { dateTime: '2026-01-16T09:30:00-05:00' },
        },
      ],
      nextPageToken: 'next-page-token',
    });

    const result = await listCalendarEvents.invoke(
      {},
      { configurable: { access_token: 'calendar-access-token' } },
    );

    expect(result).toContain('Team Sync');
    expect(result).toContain('only the first 250 events are shown');
  });

  it('omits the truncation notice when the response has a single page', async () => {
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

    const result = await listCalendarEvents.invoke(
      {},
      { configurable: { access_token: 'calendar-access-token' } },
    );

    expect(result).not.toContain('only the first 250 events are shown');
  });

  it('formats a multi-day all-day event with inclusive end date', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'event-multi',
          summary: 'Company Retreat',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-13' },
        },
      ],
    });

    const result = await listCalendarEvents.invoke(
      {},
      { configurable: { access_token: 'calendar-access-token' } },
    );

    expect(result).toContain('2026-02-10 to 2026-02-12 (all day)');
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listCalendarEvents.invoke({}, {}),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});

describe('getCalendarEvent', () => {
  it('fetches an event by ID and returns formatted event details', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'abc',
      summary: 'Planning Offsite',
      location: 'HQ',
      description: 'Review roadmap and assign owners.',
      attendees: [{ email: 'lead@example.com' }, { email: 'pm@example.com' }],
      recurringEventId: 'abc-series',
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
      start: { date: '2026-02-10' },
      end: { date: '2026-02-13' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'abc' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Planning Offsite');
    expect(result).toContain('When: 2026-02-10 to 2026-02-12 (all day)');
    expect(result).toContain('Location: HQ');
    expect(result).toContain('Description: Review roadmap and assign owners.');
    expect(result).toContain('Attendees: lead@example.com, pm@example.com');
    expect(result).toContain('Recurring: yes');
    expect(result).toContain('Status: confirmed');
    expect(result).toContain(
      'Link: https://calendar.google.com/calendar/event?eid=abc',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/abc',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
  });

  it('omits optional fields when they are absent from the event response', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-123',
      summary: 'Focus Block',
      status: 'tentative',
      start: { dateTime: '2026-01-16T13:00:00-05:00' },
      end: { dateTime: '2026-01-16T15:00:00-05:00' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'event-123' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain(
      'When: 2026-01-16T13:00:00-05:00 to 2026-01-16T15:00:00-05:00',
    );
    expect(result).toContain('Status: tentative');
    expect(result).not.toContain('Location:');
    expect(result).not.toContain('Description:');
    expect(result).not.toContain('Attendees:');
    expect(result).not.toContain('Recurring:');
  });

  it('marks a recurring series master event as recurring', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'series-master',
      summary: 'Daily Standup',
      recurrence: ['RRULE:FREQ=DAILY'],
      start: { dateTime: '2026-01-16T09:00:00-05:00' },
      end: { dateTime: '2026-01-16T09:15:00-05:00' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'series-master' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Recurring: yes');
  });

  it('returns a friendly not-found message when the Google API responds with 404', async () => {
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

    await expect(
      getCalendarEvent.invoke(
        { eventId: 'abc' },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe("No event found with ID 'abc'.");
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getCalendarEvent.invoke({ eventId: 'abc' }, {}),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});

describe('createCalendarEvent', () => {
  it('creates a timed event and returns formatted event details', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'created-1',
      summary: 'Meeting',
      location: 'Room 4',
      description: 'Discuss launch plan.',
      attendees: [{ email: 'a@b.com' }],
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=created-1',
      start: { dateTime: '2026-03-10T09:00:00-05:00' },
      end: { dateTime: '2026-03-10T10:00:00-05:00' },
    });

    const result = await createCalendarEvent.invoke(
      {
        summary: 'Meeting',
        startDateTime: '2026-03-10T09:00:00-05:00',
        endDateTime: '2026-03-10T10:00:00-05:00',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Meeting');
    expect(result).toContain(
      'When: 2026-03-10T09:00:00-05:00 to 2026-03-10T10:00:00-05:00',
    );
    expect(result).toContain('Location: Room 4');
    expect(result).toContain('Description: Discuss launch plan.');
    expect(result).toContain('Attendees: a@b.com');
    expect(result).toContain('Status: confirmed');
    expect(result).toContain(
      'Link: https://calendar.google.com/calendar/event?eid=created-1',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: 'Meeting',
          start: { dateTime: '2026-03-10T09:00:00-05:00' },
          end: { dateTime: '2026-03-10T10:00:00-05:00' },
        }),
      },
      'calendar-access-token',
    );
  });

  it('creates a single-day all-day event with an exclusive end date', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'created-2',
      summary: 'Company Holiday',
      start: { date: '2026-02-10' },
      end: { date: '2026-02-11' },
      status: 'confirmed',
    });

    await createCalendarEvent.invoke(
      {
        summary: 'Company Holiday',
        startDate: '2026-02-10',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          summary: 'Company Holiday',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-11' },
        }),
      }),
      'calendar-access-token',
    );
  });

  it('creates a multi-day all-day event with attendees and optional fields', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'created-3',
      summary: 'Offsite',
      location: 'Detroit',
      description: 'Planning and team building.',
      attendees: [{ email: 'a@b.com' }],
      status: 'confirmed',
      start: { date: '2026-02-10' },
      end: { date: '2026-02-13' },
    });

    const result = await createCalendarEvent.invoke(
      {
        summary: 'Offsite',
        startDate: '2026-02-10',
        endDate: '2026-02-12',
        location: 'Detroit',
        description: 'Planning and team building.',
        attendees: ['a@b.com'],
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('When: 2026-02-10 to 2026-02-12 (all day)');
    expect(result).toContain('Location: Detroit');
    expect(result).toContain('Description: Planning and team building.');
    expect(result).toContain('Attendees: a@b.com');
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          summary: 'Offsite',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-13' },
          location: 'Detroit',
          description: 'Planning and team building.',
          attendees: [{ email: 'a@b.com' }],
        }),
      }),
      'calendar-access-token',
    );
  });

  it('rejects when no timed or all-day start fields are provided', async () => {
    await expect(
      createCalendarEvent.invoke(
        { summary: 'Meeting' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow(
      'Provide either startDateTime for a timed event or startDate for an all-day event.',
    );
  });

  it('rejects when timed and all-day fields are mixed', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Meeting',
          startDateTime: '2026-03-10T09:00:00-05:00',
          endDateTime: '2026-03-10T10:00:00-05:00',
          startDate: '2026-03-10',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow(
      'Timed event fields and all-day event fields cannot be combined.',
    );
  });

  it('rejects when startDateTime is provided without endDateTime', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Meeting',
          startDateTime: '2026-03-10T09:00:00-05:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow(
      'endDateTime is required when startDateTime is provided.',
    );
  });

  it('rejects when endDateTime is provided without startDateTime', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Meeting',
          endDateTime: '2026-03-10T10:00:00-05:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow(
      'startDateTime is required when endDateTime is provided.',
    );
  });

  it('rejects when endDate is provided without startDate', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Offsite',
          endDate: '2026-02-12',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('startDate is required when endDate is provided.');
  });

  it('rejects impossible calendar dates', async () => {
    await expect(
      createCalendarEvent.invoke(
        { summary: 'Bad date', startDate: '2026-02-31' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('startDate "2026-02-31" is not a valid calendar date.');

    await expect(
      createCalendarEvent.invoke(
        { summary: 'Bad date', startDate: '2026-06-31' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('startDate "2026-06-31" is not a valid calendar date.');

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Bad end',
          startDate: '2026-02-10',
          endDate: '2026-02-30',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDate "2026-02-30" is not a valid calendar date.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when endDate is before startDate', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Backwards',
          startDate: '2026-02-12',
          endDate: '2026-02-10',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDate must not be before startDate.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when endDateTime is not after startDateTime', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Backwards',
          startDateTime: '2026-03-10T10:00:00-05:00',
          endDateTime: '2026-03-10T09:00:00-05:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDateTime must be after startDateTime.');

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Zero-length',
          startDateTime: '2026-03-10T10:00:00-05:00',
          endDateTime: '2026-03-10T10:00:00-05:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDateTime must be after startDateTime.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('accepts mixed-offset datetimes when end is chronologically after start', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'mixed-tz',
      summary: 'Cross-TZ',
      status: 'confirmed',
      start: { dateTime: '2026-03-10T10:00:00+02:00' },
      end: { dateTime: '2026-03-10T09:30:00+01:00' },
    });

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Cross-TZ',
          startDateTime: '2026-03-10T10:00:00+02:00',
          endDateTime: '2026-03-10T09:30:00+01:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).resolves.toContain('Event: Cross-TZ');
  });
});

describe('updateCalendarEvent', () => {
  it('interrupts for approval, patches the event, and returns formatted event details', async () => {
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
        summary: 'Team Standup',
        location: 'Room 1',
        description: 'Weekly sync.',
        attendees: [{ email: 'lead@example.com' }],
        status: 'confirmed',
        start: { dateTime: '2026-03-10T09:00:00-05:00' },
        end: { dateTime: '2026-03-10T09:30:00-05:00' },
      });
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await updateCalendarEvent.invoke(
      {
        eventId: 'event-1',
        summary: 'Team Standup',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(interrupt).toHaveBeenCalledWith({
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
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
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
      'calendar-access-token',
    );
    expect(result).toContain('Event: Team Standup');
    expect(result).toContain(
      'When: 2026-03-10T09:00:00-05:00 to 2026-03-10T09:30:00-05:00',
    );
    expect(result).toContain('Status: confirmed');
  });

  it('returns a cancellation message when the update is rejected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-2',
      summary: 'Planning',
      start: { date: '2026-04-01' },
      end: { date: '2026-04-02' },
    });
    vi.mocked(interrupt).mockReturnValue('reject');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-2',
          summary: 'Quarterly Planning',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('Update cancelled.');

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('uses recurringEventId when updating the full recurring series', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'instance-1',
        recurringEventId: 'series-1',
        summary: '1:1',
        start: { dateTime: '2026-05-01T10:00:00-04:00' },
        end: { dateTime: '2026-05-01T10:30:00-04:00' },
      })
      .mockResolvedValueOnce({
        id: 'series-1',
        summary: 'Manager 1:1',
        start: { dateTime: '2026-05-01T10:00:00-04:00' },
        end: { dateTime: '2026-05-01T10:30:00-04:00' },
      });
    vi.mocked(interrupt).mockReturnValue('approve');

    await updateCalendarEvent.invoke(
      {
        eventId: 'instance-1',
        recurringEventScope: 'all',
        summary: 'Manager 1:1',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Update "1:1" (all instances): summary → "Manager 1:1"',
        proposed: {
          recurringEventScope: 'all',
          summary: 'Manager 1:1',
        },
      }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/series-1',
      expect.objectContaining({ method: 'PATCH' }),
      'calendar-access-token',
    );
  });

  it('falls back to the provided eventId when recurring scope is all on a non-recurring event', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-3',
        summary: 'Deep Work',
        start: { date: '2026-06-02' },
        end: { date: '2026-06-03' },
      })
      .mockResolvedValueOnce({
        id: 'event-3',
        summary: 'Focus Block',
        start: { date: '2026-06-02' },
        end: { date: '2026-06-03' },
      });
    vi.mocked(interrupt).mockReturnValue('approve');

    await updateCalendarEvent.invoke(
      {
        eventId: 'event-3',
        recurringEventScope: 'all',
        summary: 'Focus Block',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Update "Deep Work": summary → "Focus Block"',
      }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-3',
      expect.objectContaining({ method: 'PATCH' }),
      'calendar-access-token',
    );
  });

  it('returns a friendly not-found message when the event does not exist', async () => {
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

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'missing-event',
          summary: 'New title',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe("No event found with ID 'missing-event'.");

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a deleted-event message without interrupting when the event is cancelled', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-cancelled',
      summary: 'Trashed Event',
      status: 'cancelled',
      start: { dateTime: '2026-07-01T14:00:00-04:00' },
      end: { dateTime: '2026-07-01T15:00:00-04:00' },
    });
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-cancelled',
          summary: 'Updated Title',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "Event 'event-cancelled' has been deleted, so it cannot be updated.",
    );

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('reports an unverified update when the patch response body is empty', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-3',
        summary: 'Team Sync',
        start: { dateTime: '2026-03-10T09:00:00-05:00' },
        end: { dateTime: '2026-03-10T09:30:00-05:00' },
      })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-3',
          summary: 'Team Standup',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "The update request for event 'event-3' completed, but Google did not return the updated event. Ask the user to verify the change in their calendar.",
    );
  });

  it('returns a friendly message when the event is deleted between interrupt and resume', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-deleted',
        summary: 'Doomed Event',
        start: { dateTime: '2026-07-01T14:00:00-04:00' },
        end: { dateTime: '2026-07-01T15:00:00-04:00' },
      })
      .mockRejectedValueOnce(
        new GoogleApiError(
          'GOOGLE_API_REQUEST_FAILED',
          'Google API request failed with status 404.',
          {
            retryable: false,
            status: 404,
          },
        ),
      );
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-deleted',
          summary: 'Updated Title',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "No event found with ID 'event-deleted'. It may no longer exist.",
    );

    expect(interrupt).toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('treats a 410 on the patch call as a missing event', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-gone',
        summary: 'Doomed Event',
        start: { dateTime: '2026-07-01T14:00:00-04:00' },
        end: { dateTime: '2026-07-01T15:00:00-04:00' },
      })
      .mockRejectedValueOnce(
        new GoogleApiError(
          'GOOGLE_API_REQUEST_FAILED',
          'Google API request failed with status 410.',
          {
            retryable: false,
            status: 410,
          },
        ),
      );
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-gone',
          summary: 'Updated Title',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "No event found with ID 'event-gone'. It may no longer exist.",
    );
  });

  it('rejects when no update fields are provided', async () => {
    await expect(
      updateCalendarEvent.invoke(
        { eventId: 'event-4' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('Provide at least one field to update.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('rejects when timed and all-day fields are mixed', async () => {
    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-5',
          startDateTime: '2026-03-10T09:00:00-05:00',
          startDate: '2026-03-10',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow(
      'Timed event fields and all-day event fields cannot be combined.',
    );

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects impossible calendar dates', async () => {
    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-6',
          startDate: '2026-02-31',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('startDate "2026-02-31" is not a valid calendar date.');

    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-6',
          endDate: '2026-02-30',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDate "2026-02-30" is not a valid calendar date.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when endDate is before startDate', async () => {
    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-7',
          startDate: '2026-02-12',
          endDate: '2026-02-10',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDate must not be before startDate.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when endDateTime is not after startDateTime', async () => {
    await expect(
      updateCalendarEvent.invoke(
        {
          eventId: 'event-8',
          startDateTime: '2026-03-10T10:00:00-05:00',
          endDateTime: '2026-03-10T09:00:00-05:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow('endDateTime must be after startDateTime.');

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('deleteCalendarEvent', () => {
  it('interrupts for approval, deletes the event, and returns a confirmation', async () => {
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
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    const result = await deleteCalendarEvent.invoke(
      {
        eventId: 'event-1',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(interrupt).toHaveBeenCalledWith({
      action: 'delete_calendar_event',
      description: 'Delete "Team Sync".',
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
      proposed: null,
    });
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1',
      {
        method: 'DELETE',
      },
      'calendar-access-token',
    );
    expect(result).toBe('Deleted "Team Sync".');
  });

  it('returns a cancellation message when the deletion is rejected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-2',
      summary: 'Planning',
      start: { date: '2026-04-01' },
      end: { date: '2026-04-02' },
    });
    vi.mocked(interrupt).mockReturnValue('reject');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'event-2',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('Deletion cancelled.');

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('uses recurringEventId when deleting the full recurring series', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'instance-1',
        recurringEventId: 'series-1',
        summary: '1:1',
        start: { dateTime: '2026-05-01T10:00:00-04:00' },
        end: { dateTime: '2026-05-01T10:30:00-04:00' },
      })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'instance-1',
          recurringEventScope: 'all',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('Deleted "1:1" (all instances).');

    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Delete "1:1" (all instances).',
        proposed: null,
      }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/series-1',
      expect.objectContaining({ method: 'DELETE' }),
      'calendar-access-token',
    );
  });

  it('falls back to the provided eventId when recurring scope is all on a non-recurring event', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-3',
        summary: 'Deep Work',
        start: { date: '2026-06-02' },
        end: { date: '2026-06-03' },
      })
      .mockResolvedValueOnce(null);
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'event-3',
          recurringEventScope: 'all',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('Deleted "Deep Work".');

    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Delete "Deep Work".',
      }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-3',
      expect.objectContaining({ method: 'DELETE' }),
      'calendar-access-token',
    );
  });

  it('returns a friendly not-found message when the event does not exist', async () => {
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

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'missing-event',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe("No event found with ID 'missing-event'.");

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns an already-deleted message without interrupting when the event is cancelled', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-cancelled',
      summary: 'Trashed Event',
      status: 'cancelled',
      start: { dateTime: '2026-07-01T14:00:00-04:00' },
      end: { dateTime: '2026-07-01T15:00:00-04:00' },
    });
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'event-cancelled',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('Event "Trashed Event" has already been deleted.');

    expect(interrupt).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a friendly message when the event is deleted between interrupt and resume', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-deleted',
        summary: 'Doomed Event',
        start: { dateTime: '2026-07-01T14:00:00-04:00' },
        end: { dateTime: '2026-07-01T15:00:00-04:00' },
      })
      .mockRejectedValueOnce(
        new GoogleApiError(
          'GOOGLE_API_REQUEST_FAILED',
          'Google API request failed with status 404.',
          {
            retryable: false,
            status: 404,
          },
        ),
      );
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'event-deleted',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "No event found with ID 'event-deleted'. It may no longer exist.",
    );

    expect(interrupt).toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('treats a 410 on the delete call as an already-deleted event', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({
        id: 'event-gone',
        summary: 'Doomed Event',
        start: { dateTime: '2026-07-01T14:00:00-04:00' },
        end: { dateTime: '2026-07-01T15:00:00-04:00' },
      })
      .mockRejectedValueOnce(
        new GoogleApiError(
          'GOOGLE_API_REQUEST_FAILED',
          'Google API request failed with status 410.',
          {
            retryable: false,
            status: 410,
          },
        ),
      );
    vi.mocked(interrupt).mockReturnValue('approve');

    await expect(
      deleteCalendarEvent.invoke(
        {
          eventId: 'event-gone',
        },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe(
      "No event found with ID 'event-gone'. It may no longer exist.",
    );

    expect(interrupt).toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      deleteCalendarEvent.invoke({ eventId: 'event-9' }, {}),
    ).rejects.toMatchObject<AisistAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
