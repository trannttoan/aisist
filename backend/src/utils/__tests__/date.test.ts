import { describe, expect, it } from 'vitest';

import { isValidLocalDateTime, toLocalDateTime, toRfc3339 } from '../date.js';

describe('isValidLocalDateTime', () => {
  it('accepts wall-clock times with or without seconds', () => {
    expect(isValidLocalDateTime('2026-10-06T20:00')).toBe(true);
    expect(isValidLocalDateTime('2026-10-06T20:00:30')).toBe(true);
  });

  it('rejects offsets, impossible times, and other shapes', () => {
    expect(isValidLocalDateTime('2026-10-06T20:00:00Z')).toBe(false);
    expect(isValidLocalDateTime('2026-10-06T20:00:00-04:00')).toBe(false);
    expect(isValidLocalDateTime('2026-10-06T24:00')).toBe(false);
    expect(isValidLocalDateTime('2026-02-30T10:00')).toBe(false);
    expect(isValidLocalDateTime('2026-10-06')).toBe(false);
  });
});

describe('toRfc3339', () => {
  it('adds the offset the timezone has at that moment', () => {
    expect(toRfc3339('2026-10-06T20:00', 'America/New_York')).toBe(
      '2026-10-06T20:00:00-04:00',
    );
    expect(toRfc3339('2026-12-06T20:00', 'America/New_York')).toBe(
      '2026-12-06T20:00:00-05:00',
    );
    expect(toRfc3339('2026-10-06T20:00:15', 'Asia/Kolkata')).toBe(
      '2026-10-06T20:00:15+05:30',
    );
    expect(toRfc3339('2026-10-06T20:00', 'UTC')).toBe(
      '2026-10-06T20:00:00+00:00',
    );
  });

  it('uses the new offset right after a DST change', () => {
    // US DST ends 2026-11-01 at 02:00; 01:30 that day is still EDT.
    expect(toRfc3339('2026-11-01T01:30', 'America/New_York')).toBe(
      '2026-11-01T01:30:00-04:00',
    );
    expect(toRfc3339('2026-11-01T03:00', 'America/New_York')).toBe(
      '2026-11-01T03:00:00-05:00',
    );
  });
});

describe('toLocalDateTime', () => {
  it("shows an instant as wall-clock time in the user's timezone", () => {
    expect(toLocalDateTime('2026-10-11T13:00:00Z', 'America/New_York')).toBe(
      '2026-10-11T09:00',
    );
    expect(toLocalDateTime('2026-12-11T13:00:00Z', 'America/New_York')).toBe(
      '2026-12-11T08:00',
    );
    expect(toLocalDateTime('2026-10-11T09:00:00-04:00', 'Asia/Kathmandu')).toBe(
      '2026-10-11T18:45',
    );
  });

  it('crosses midnight and drops seconds', () => {
    expect(toLocalDateTime('2026-10-12T03:30:59Z', 'America/New_York')).toBe(
      '2026-10-11T23:30',
    );
    expect(toLocalDateTime('2026-10-11T00:00:00Z', 'UTC')).toBe(
      '2026-10-11T00:00',
    );
  });

  it('round-trips with toRfc3339', () => {
    const local = '2026-11-01T03:00';

    expect(
      toLocalDateTime(toRfc3339(local, 'America/New_York'), 'America/New_York'),
    ).toBe(local);
  });
});
