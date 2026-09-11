import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, normalizeTimezone } from '../prompt.js';

describe('normalizeTimezone', () => {
  it('returns UTC when timezone is undefined', () => {
    expect(normalizeTimezone()).toBe('UTC');
  });

  it('returns UTC when timezone is an empty string', () => {
    expect(normalizeTimezone('')).toBe('UTC');
  });

  it('returns UTC when timezone is an invalid IANA string', () => {
    expect(normalizeTimezone('Not/A/Timezone')).toBe('UTC');
  });

  it('returns the timezone when it is a valid IANA timezone', () => {
    expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
  });
});

describe('buildSystemPrompt', () => {
  const fixedNow = new Date(Date.UTC(2026, 0, 15, 10, 30, 0));

  it('includes the formatted date for a fixed now value', () => {
    const result = buildSystemPrompt({ timezone: 'UTC', now: fixedNow });

    expect(result).toContain('Thursday, January 15, 2026');
  });

  it('includes the formatted time for a fixed now value', () => {
    const result = buildSystemPrompt({ timezone: 'UTC', now: fixedNow });

    expect(result).toContain('10:30');
  });

  it('includes the provided timezone', () => {
    const result = buildSystemPrompt({
      timezone: 'America/New_York',
      now: fixedNow,
    });

    expect(result).toContain("User's timezone: America/New_York");
  });

  it('falls back to UTC when timezone is undefined', () => {
    const result = buildSystemPrompt({ now: fixedNow });

    expect(result).toContain("User's timezone: UTC");
  });

  it('falls back to UTC when timezone is invalid', () => {
    const result = buildSystemPrompt({
      timezone: 'Invalid/Zone',
      now: fixedNow,
    });

    expect(result).toContain("User's timezone: UTC");
  });

  it('contains the Aisist identity preamble', () => {
    const result = buildSystemPrompt({ now: fixedNow });

    expect(result).toContain('You are Aisist, a personal assistant');
  });

  it('contains the rules section', () => {
    const result = buildSystemPrompt({ now: fixedNow });

    expect(result).toContain('create an event or task');
    expect(result).toContain('approval before the change goes through');
  });

  it('exempts marking a task complete or incomplete from approval', () => {
    const result = buildSystemPrompt({ now: fixedNow });

    expect(result).toContain(
      'marking a task complete or incomplete does not need approval',
    );
  });

  it('forbids showing task and task list IDs alongside event IDs', () => {
    const result = buildSystemPrompt({ now: fixedNow });

    expect(result).toContain(
      'Never show event, task, or task list IDs to the user',
    );
  });
});
