export function isValidCalendarDate(dateStr: string): boolean {
  const date = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(date.getTime())) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() + 1 === m &&
    date.getUTCDate() === d
  );
}

const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidLocalDateTime(value: string): boolean {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [, date, hour, minute, second = '00'] = match;

  return (
    isValidCalendarDate(date!) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60
  );
}

// Google needs an offset on every date-time and the model gives wall-clock
// time, so the offset is the user's timezone at that moment.
export function toRfc3339(localDateTime: string, timezone: string): string {
  const match = LOCAL_DATE_TIME_PATTERN.exec(localDateTime);

  if (!match) {
    throw new Error(`"${localDateTime}" is not a local date-time.`);
  }

  const [, date, hour, minute, second = '00'] = match;
  const wallClock = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  let offsetMinutes = 0;

  // The first guess can land on the other side of a DST change.
  for (let pass = 0; pass < 2; pass += 1) {
    offsetMinutes = getOffsetMinutes(
      timezone,
      new Date(wallClock - offsetMinutes * 60_000),
    );
  }

  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date}T${hour}:${minute}:${second}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// The inverse of toRfc3339: the wall-clock time an instant shows in the
// user's timezone, as YYYY-MM-DDTHH:MM.
export function toLocalDateTime(rfc3339: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(rfc3339))
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function getOffsetMinutes(timezone: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);

  if (!match) {
    throw new Error(`Unexpected offset "${name}" for timezone ${timezone}.`);
  }

  const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);

  return match[1] === '-' ? -minutes : minutes;
}
