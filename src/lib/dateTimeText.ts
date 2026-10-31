const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local `datetime-local` value to the minute (`YYYY-MM-DDTHH:MM`). */
export function toDateTimeLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `YYYY-MM-DD HH:MM` for display and editing. */
export function formatDateTimeLocal(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

const DATE_TIME_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** Compact `YYYYMMDD`, optionally followed by `HHMM` or `HH:MM`. */
const COMPACT_DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2}))?$/;

/**
 * Parses typed local date/time text into a minute-precision `datetime-local` value, or
 * null when it is not a real date/time. A date alone means midnight; seconds are dropped.
 * e.g. "2026-1-5" → "2026-01-05T00:00", "2026-01-05 14:30:15" → "2026-01-05T14:30",
 * "20261030" → "2026-10-30T00:00", "20261030 1430" → "2026-10-30T14:30".
 */
export function parseDateTimeText(text: string): string | null {
  const trimmed = text.trim();
  const match = DATE_TIME_RE.exec(trimmed) ?? COMPACT_DATE_TIME_RE.exec(trimmed);
  if (!match) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part))) as number[];
  const date = new Date(year!, month! - 1, day!, hour, minute, second);
  // Reject rollovers such as Feb 30 or 25:00.
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month! - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second;
  return valid ? toDateTimeLocal(date) : null;
}
