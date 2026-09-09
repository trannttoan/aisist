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
