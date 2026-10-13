/**
 * VICIdial stores timestamps in the dialer server's local time. Every dialer
 * row carries an IANA timezone; these helpers convert between that local time
 * and UTC without external libraries.
 */

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** 'YYYY-MM-DD HH:MM:SS' in `timeZone` -> UTC Date. */
export function localToUtc(localStr: string, timeZone: string): Date {
  const m = localStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Unparseable VICIdial timestamp: ${localStr}`);
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes handle DST boundaries: offset at the guessed instant, re-applied.
  let utc = naive - tzOffsetMs(new Date(naive), timeZone);
  utc = naive - tzOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

/** UTC Date -> 'YYYY-MM-DD HH:MM:SS' rendered in `timeZone` (for MySQL WHERE bounds). */
export function utcToLocalString(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}
