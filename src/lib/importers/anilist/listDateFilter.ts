/**
 * "list date" chip logic: filters on the user's own list-entry
 * started / completed dates. Months are encoded as `year * 12 + (month - 1)`;
 * days are ignored.
 */

export type ListDateField = 'active' | 'started' | 'completed';

export type ListDateFilterState = {
  listDateField: ListDateField;
  /** Encoded month, or null for open-ended. */
  listDateMin: number | null;
  listDateMax: number | null;
};

export const DEFAULT_LIST_DATE_FILTER: ListDateFilterState = {
  listDateField: 'active',
  listDateMin: null,
  listDateMax: null,
};

/** One list entry's dates; a null year means the date isn't set. */
export type ListEntryDates = {
  startedYear: number | null;
  startedMonth: number | null;
  completedYear: number | null;
  completedMonth: number | null;
};

export const LIST_DATE_FIELDS: readonly ListDateField[] = ['active', 'started', 'completed'];

/** Display names; `completed` is shown as "finished" like AniList / MAL's "Finish Date". */
export const LIST_DATE_FIELD_LABELS: Readonly<Record<ListDateField, string>> = {
  active: 'active',
  started: 'started',
  completed: 'finished',
};

/** Chip name: "read dates" for manga lists, "watch dates" otherwise. */
export function listDateChipName(mediaType: 'ANIME' | 'MANGA' | null | undefined): string {
  return mediaType === 'MANGA' ? 'read dates' : 'watch dates';
}

export function encodeListMonth(year: number, month: number): number {
  return year * 12 + (month - 1);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function listMonthYear(encoded: number): number {
  return Math.floor(encoded / 12);
}

/** `April 2023` style label for an encoded month. */
export function formatListMonth(encoded: number): string {
  return `${MONTH_NAMES[encoded % 12]} ${listMonthYear(encoded)}`;
}

/**
 * Parses `YYYYMM`, `YYYY/MM` or `YYYY-MM`, or a bare `YYYY` meaning `edge`
 * of that year. '' is null, invalid is undefined.
 *
 * @example parseListMonth('202610', 'start') → October 2026; parseListMonth('2026', 'end') → December 2026
 */
export function parseListMonth(text: string, edge: 'start' | 'end'): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const match = /^(\d{4})(?:[/-]?(\d{1,2}))?$/.exec(trimmed);
  if (!match) return undefined;
  const year = Number(match[1]);
  if (match[2] === undefined) return encodeListMonth(year, edge === 'start' ? 1 : 12);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return encodeListMonth(year, month);
}

export function listDateFilterActive(state: ListDateFilterState): boolean {
  return state.listDateMin !== null || state.listDateMax !== null;
}

/** [earliest, latest] month a date could be; a year-only date spans the whole year. */
function monthSpan(year: number | null, month: number | null): [number, number] | null {
  if (year == null || year <= 0) return null;
  if (month == null || month < 1 || month > 12) {
    return [encodeListMonth(year, 1), encodeListMonth(year, 12)];
  }
  const encoded = encodeListMonth(year, month);
  return [encoded, encoded];
}

function overlaps(span: [number, number], min: number | null, max: number | null): boolean {
  return (min === null || span[1] >= min) && (max === null || span[0] <= max);
}

/**
 * Whether an entry passes the chip. With no range set everything passes;
 * with a range set, entries without the needed date are hidden.
 *
 * `active` passes when the entry was on the go at some
 * point in the range: started on or before the range end, and completed
 * on or after the range start (or not completed, i.e. still ongoing).
 *
 * @example started 2022/12, completed 2024/03, range 2023/01..2023/12 → true
 */
export function listDatePasses(
  dates: ListEntryDates | null | undefined,
  state: ListDateFilterState,
): boolean {
  if (!listDateFilterActive(state)) return true;
  if (!dates) return false;
  const { listDateMin: min, listDateMax: max } = state;
  const started = monthSpan(dates.startedYear, dates.startedMonth);
  const completed = monthSpan(dates.completedYear, dates.completedMonth);
  if (state.listDateField === 'started') return started !== null && overlaps(started, min, max);
  if (state.listDateField === 'completed') return completed !== null && overlaps(completed, min, max);
  if (started === null) return false;
  const startsInTime = max === null || started[0] <= max;
  const endsInTime = min === null || completed === null || completed[1] >= min;
  return startsInTime && endsInTime;
}

/** List date chip on multi-user tools, with "one person" (any) vs "everyone" (all). */
export type MultiUserListDateFilter = { state: ListDateFilterState; mode: 'any' | 'all' };

export const DEFAULT_MULTI_USER_LIST_DATE_FILTER: MultiUserListDateFilter = {
  state: DEFAULT_LIST_DATE_FILTER,
  mode: 'any',
};

export function normalizeMultiUserListDateFilter(state: unknown, mode: unknown): MultiUserListDateFilter {
  return { state: normalizeListDateFilter(state), mode: mode === 'all' ? 'all' : 'any' };
}

/** Multi-user check: `any` passes if one entry passes, `all` only if every entry does. */
export function listDatesPassForUsers(
  entries: readonly (ListEntryDates | null | undefined)[],
  state: ListDateFilterState,
  mode: 'any' | 'all',
): boolean {
  if (!listDateFilterActive(state)) return true;
  if (entries.length === 0) return false;
  return mode === 'all'
    ? entries.every((entry) => listDatePasses(entry, state))
    : entries.some((entry) => listDatePasses(entry, state));
}

function currentMonth(now: Date): number {
  return encodeListMonth(now.getFullYear(), now.getMonth() + 1);
}

/**
 * Sorted month steps for the slider, taken from the dates on the list.
 * `active` uses both dates, plus the current month when something is ongoing.
 */
export function listDateOptions(
  entries: readonly (ListEntryDates | null | undefined)[],
  field: ListDateField,
  now: Date = new Date(),
): number[] {
  const months = new Set<number>();
  let ongoing = false;
  for (const entry of entries) {
    if (!entry) continue;
    const started = monthSpan(entry.startedYear, entry.startedMonth);
    const completed = monthSpan(entry.completedYear, entry.completedMonth);
    if (field !== 'completed' && started) months.add(started[0]);
    if (field !== 'started' && completed) months.add(completed[1]);
    if (field === 'active' && started && !completed) ongoing = true;
  }
  if (ongoing) months.add(currentMonth(now));
  return [...months].sort((a, b) => a - b);
}

/** Reads `started_*` / `completed_*` columns off a list-entry row. */
export function listEntryDatesFromRow(row: {
  started_year?: number | null;
  started_month?: number | null;
  completed_year?: number | null;
  completed_month?: number | null;
}): ListEntryDates {
  return {
    startedYear: row.started_year ?? null,
    startedMonth: row.started_month ?? null,
    completedYear: row.completed_year ?? null,
    completedMonth: row.completed_month ?? null,
  };
}

/** Reads AniList `startedAt` / `completedAt` fuzzy dates. */
export function listEntryDatesFromFuzzy(
  startedAt: { year?: number | null; month?: number | null } | null | undefined,
  completedAt: { year?: number | null; month?: number | null } | null | undefined,
): ListEntryDates {
  return {
    startedYear: startedAt?.year ?? null,
    startedMonth: startedAt?.month ?? null,
    completedYear: completedAt?.year ?? null,
    completedMonth: completedAt?.month ?? null,
  };
}

/** Reads MAL `start_date` / `finish_date` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). */
export function listEntryDatesFromMal(
  startDate: string | null | undefined,
  finishDate: string | null | undefined,
): ListEntryDates {
  const parse = (text: string | null | undefined): [number | null, number | null] => {
    const match = /^(\d{4})(?:-(\d{2}))?/.exec(text ?? '');
    if (!match) return [null, null];
    return [Number(match[1]), match[2] ? Number(match[2]) : null];
  };
  const [startedYear, startedMonth] = parse(startDate);
  const [completedYear, completedMonth] = parse(finishDate);
  return { startedYear, startedMonth, completedYear, completedMonth };
}

/** Restores persisted state, falling back to defaults for missing or bad fields. */
export function normalizeListDateFilter(raw: unknown): ListDateFilterState {
  const value = (raw ?? {}) as Partial<Record<keyof ListDateFilterState, unknown>>;
  const field = LIST_DATE_FIELDS.includes(value.listDateField as ListDateField)
    ? (value.listDateField as ListDateField)
    : DEFAULT_LIST_DATE_FILTER.listDateField;
  const bound = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { listDateField: field, listDateMin: bound(value.listDateMin), listDateMax: bound(value.listDateMax) };
}
