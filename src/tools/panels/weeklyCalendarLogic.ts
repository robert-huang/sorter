import { encodeSeasonYear } from '../../lib/importers/anilist/filters';
import type { AnilistMediaSeason, AnilistMediaStatus } from '../../lib/importers/anilist/types';
import { TOOLS_SEASONAL_LIST_STATUSES } from '../../lib/importers/anilist/toolsAnilistAccess';
import {
  fuzzyDateToCalendarKey,
  normalizeSeasonalListScore,
  type SeasonalFuzzyDate,
} from './seasonalScoresLogic';

export const WEEKLY_CALENDAR_WATCHING_STATUSES = ['CURRENT', 'REPEATING'] as const;

/** Pseudo-status for season browse rows with no list entry for the user. */
export const WEEKLY_CALENDAR_NOT_ON_LIST_FILTER = 'NOT_ON_LIST' as const;

export const WEEKLY_CALENDAR_NOT_ON_LIST_LABEL = 'NOT ON LIST' as const;

export type WeeklyCalendarAnilistListStatus = (typeof TOOLS_SEASONAL_LIST_STATUSES)[number];

export type WeeklyCalendarListStatusFilter =
  | WeeklyCalendarAnilistListStatus
  | typeof WEEKLY_CALENDAR_NOT_ON_LIST_FILTER;

export const WEEKLY_CALENDAR_LIST_STATUS_OPTIONS = [
  ...TOOLS_SEASONAL_LIST_STATUSES,
  WEEKLY_CALENDAR_NOT_ON_LIST_FILTER,
] as const satisfies readonly WeeklyCalendarListStatusFilter[];

export const DEFAULT_WEEKLY_CALENDAR_LIST_STATUS_FILTERS: WeeklyCalendarListStatusFilter[] = [
  'CURRENT',
  'REPEATING',
];

export function formatWeeklyCalendarListStatusFilterLabel(
  status: WeeklyCalendarListStatusFilter,
): string {
  if (status === WEEKLY_CALENDAR_NOT_ON_LIST_FILTER) {
    return WEEKLY_CALENDAR_NOT_ON_LIST_LABEL;
  }
  return status;
}

export function normalizeWeeklyCalendarListStatusFilters(
  raw: unknown,
): WeeklyCalendarListStatusFilter[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_WEEKLY_CALENDAR_LIST_STATUS_FILTERS];
  }
  const selected = WEEKLY_CALENDAR_LIST_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_WEEKLY_CALENDAR_LIST_STATUS_FILTERS];
}

export function entryMatchesWeeklyListStatusFilters(
  listStatus: string | null,
  filters: readonly WeeklyCalendarListStatusFilter[],
): boolean {
  if (listStatus == null) {
    return filters.includes(WEEKLY_CALENDAR_NOT_ON_LIST_FILTER);
  }
  return filters.includes(listStatus as WeeklyCalendarAnilistListStatus);
}

export const WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS = [
  'RELEASING',
  'NOT_YET_RELEASED',
  'FINISHED',
  'HIATUS',
  'CANCELLED',
] as const satisfies readonly AnilistMediaStatus[];

export type WeeklyCalendarMediaStatusFilter = (typeof WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS)[number];

/** Default: actively airing or upcoming. */
export const DEFAULT_WEEKLY_CALENDAR_MEDIA_STATUS_FILTERS: WeeklyCalendarMediaStatusFilter[] = [
  'RELEASING',
  'NOT_YET_RELEASED',
];

export function formatWeeklyCalendarMediaStatusFilterLabel(
  status: WeeklyCalendarMediaStatusFilter,
): string {
  return status;
}

export function normalizeWeeklyCalendarMediaStatusFilters(
  raw: unknown,
): WeeklyCalendarMediaStatusFilter[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_WEEKLY_CALENDAR_MEDIA_STATUS_FILTERS];
  }
  const selected = WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_WEEKLY_CALENDAR_MEDIA_STATUS_FILTERS];
}

export function entryMatchesWeeklyMediaStatusFilters(
  mediaStatus: string | null | undefined,
  filters: readonly WeeklyCalendarMediaStatusFilter[],
): boolean {
  if (mediaStatus == null) {
    return false;
  }
  return filters.includes(mediaStatus as WeeklyCalendarMediaStatusFilter);
}

export type WeeklyCalendarWeekStartDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

export type WeeklyCalendarTimezone = 'eastern' | 'pacific' | 'utc' | 'local';

export type WeeklyCalendarSeasonScope = 'watching' | 'current' | 'next' | 'custom';

export type WeeklyCalendarForm = {
  username: string;
  weekStartDay: WeeklyCalendarWeekStartDay;
  timezone: WeeklyCalendarTimezone;
  seasonScope: WeeklyCalendarSeasonScope;
  /** Encoded season+year range when `seasonScope` is `custom` (see `encodeSeasonYear`). */
  customSeasonMinEncoded: number;
  customSeasonMaxEncoded: number;
  listStatusFilters: WeeklyCalendarListStatusFilter[];
  mediaStatusFilters: WeeklyCalendarMediaStatusFilter[];
  showUnscheduledColumn: boolean;
  showThemeSongs: boolean;
};

export function defaultWeeklyCalendarCustomSeasonEncoded(now: Date = new Date()): number {
  const current = getCurrentAnilistSeason(now);
  return encodeSeasonYear(current.season, current.year);
}

export function defaultWeeklyCalendarCustomSeasonRange(now: Date = new Date()): Pick<
  WeeklyCalendarForm,
  'customSeasonMinEncoded' | 'customSeasonMaxEncoded'
> {
  const encoded = defaultWeeklyCalendarCustomSeasonEncoded(now);
  return { customSeasonMinEncoded: encoded, customSeasonMaxEncoded: encoded };
}

const defaultCustomSeasonRange = defaultWeeklyCalendarCustomSeasonRange();

export const DEFAULT_WEEKLY_CALENDAR_FORM: WeeklyCalendarForm = {
  username: '',
  weekStartDay: 'MONDAY',
  timezone: 'eastern',
  seasonScope: 'watching',
  customSeasonMinEncoded: defaultCustomSeasonRange.customSeasonMinEncoded,
  customSeasonMaxEncoded: defaultCustomSeasonRange.customSeasonMaxEncoded,
  listStatusFilters: [...DEFAULT_WEEKLY_CALENDAR_LIST_STATUS_FILTERS],
  mediaStatusFilters: [...DEFAULT_WEEKLY_CALENDAR_MEDIA_STATUS_FILTERS],
  showUnscheduledColumn: false,
  showThemeSongs: false,
};

export type WeeklyCalendarEntry = {
  id: number;
  title: string;
  coverImage: string | null;
  score: number | null;
  listStatus: string | null;
  progress: number;
  totalEpisodes: number | null;
  popularity: number | null;
  mediaStatus: string | null;
  startDate: SeasonalFuzzyDate | null;
  endDate: SeasonalFuzzyDate | null;
  nextAiringAt: number | null;
  /** Episodes aired so far (from next-airing metadata). */
  airedCount: number | null;
  /** JS weekday 0=Sun … 6=Sat in the selected timezone. */
  weekdayJs: number | null;
  /** Minutes from local midnight for airing-time sort. */
  airingTimeMinutes: number | null;
  /** True when weekday came from past airingSchedule rather than nextAiringEpisode. */
  inferredWeekday: boolean;
};

export type WeeklyCalendarColumn = {
  key: string;
  label: string;
  /** `null` for the optional unscheduled bucket. */
  weekdayJs: number | null;
  shows: WeeklyCalendarEntry[];
};

export type WeeklyCalendarResult =
  | { kind: 'empty'; message: string }
  | { kind: 'columns'; columns: WeeklyCalendarColumn[]; seasonLabel: string | null };

const JS_WEEKDAY_BY_START: Record<WeeklyCalendarWeekStartDay, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function weeklyCalendarTimezoneToIana(timezone: WeeklyCalendarTimezone): string | undefined {
  switch (timezone) {
    case 'eastern':
      return 'America/New_York';
    case 'pacific':
      return 'America/Los_Angeles';
    case 'utc':
      return 'UTC';
    case 'local':
      return undefined;
    default:
      return undefined;
  }
}

export type AnilistSeasonAt = {
  season: AnilistMediaSeason;
  year: number;
};

/** Current AniList season from a calendar date (no 10-day overflow). */
export function getCurrentAnilistSeason(now: Date): AnilistSeasonAt {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month <= 3) {
    return { season: 'WINTER', year };
  }
  if (month <= 6) {
    return { season: 'SPRING', year };
  }
  if (month <= 9) {
    return { season: 'SUMMER', year };
  }
  return { season: 'FALL', year };
}

const ANILIST_SEASON_CYCLE: AnilistMediaSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export function getNextAnilistSeason(spec: AnilistSeasonAt): AnilistSeasonAt {
  const index = ANILIST_SEASON_CYCLE.indexOf(spec.season);
  if (index < 0 || index >= ANILIST_SEASON_CYCLE.length - 1) {
    return { season: 'WINTER', year: spec.year + 1 };
  }
  return { season: ANILIST_SEASON_CYCLE[index + 1]!, year: spec.year };
}

export function getPreviousAnilistSeason(spec: AnilistSeasonAt): AnilistSeasonAt {
  const index = ANILIST_SEASON_CYCLE.indexOf(spec.season);
  if (index <= 0) {
    return { season: 'FALL', year: spec.year - 1 };
  }
  return { season: ANILIST_SEASON_CYCLE[index - 1]!, year: spec.year };
}

export function decodeAnilistSeasonEncoded(encoded: number): AnilistSeasonAt {
  return {
    season: ANILIST_SEASON_CYCLE[encoded & 0b11]!,
    year: Math.floor(encoded / 4),
  };
}

export function compareAnilistSeasonAt(a: AnilistSeasonAt, b: AnilistSeasonAt): number {
  if (a.year !== b.year) {
    return a.year - b.year;
  }
  return ANILIST_SEASON_CYCLE.indexOf(a.season) - ANILIST_SEASON_CYCLE.indexOf(b.season);
}

export function isAnilistSeasonBeforeCurrent(spec: AnilistSeasonAt, now: Date = new Date()): boolean {
  return compareAnilistSeasonAt(spec, getCurrentAnilistSeason(now)) < 0;
}

/** Past seasons available in the custom picker (plus current through next). */
export const WEEKLY_CALENDAR_CUSTOM_SEASON_PAST_COUNT = 40;

/** Custom season picker: {@link WEEKLY_CALENDAR_CUSTOM_SEASON_PAST_COUNT} seasons ago through next. */
export function buildWeeklyCalendarCustomSeasonYearOptions(now: Date = new Date()): number[] {
  const current = getCurrentAnilistSeason(now);
  const next = getNextAnilistSeason(current);
  let min = current;
  for (let i = 0; i < WEEKLY_CALENDAR_CUSTOM_SEASON_PAST_COUNT; i++) {
    min = getPreviousAnilistSeason(min);
  }
  const options: number[] = [];
  let cursor = min;
  while (true) {
    options.push(encodeSeasonYear(cursor.season, cursor.year));
    if (cursor.season === next.season && cursor.year === next.year) {
      break;
    }
    cursor = getNextAnilistSeason(cursor);
  }
  return options;
}

export function normalizeCustomSeasonEncoded(
  encoded: number,
  options: readonly number[],
  now: Date = new Date(),
): number {
  if (options.length === 0) {
    return encoded;
  }
  if (options.includes(encoded)) {
    return encoded;
  }
  if (encoded === 0) {
    const currentEncoded = defaultWeeklyCalendarCustomSeasonEncoded(now);
    if (options.includes(currentEncoded)) {
      return currentEncoded;
    }
  }
  let best = options[0]!;
  let bestDistance = Math.abs(encoded - best);
  for (const option of options) {
    const distance = Math.abs(encoded - option);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

export function normalizeCustomSeasonRange(
  minEncoded: number,
  maxEncoded: number,
  options: readonly number[],
): { minEncoded: number; maxEncoded: number } {
  const min = normalizeCustomSeasonEncoded(minEncoded, options);
  const max = normalizeCustomSeasonEncoded(maxEncoded, options);
  const minIdx = options.indexOf(min);
  const maxIdx = options.indexOf(max);
  if (minIdx <= maxIdx) {
    return { minEncoded: min, maxEncoded: max };
  }
  return { minEncoded: max, maxEncoded: min };
}

export function enumerateCustomSeasonSpecs(
  minEncoded: number,
  maxEncoded: number,
  options: readonly number[],
): AnilistSeasonAt[] {
  if (options.length === 0) {
    return [];
  }
  const range = normalizeCustomSeasonRange(minEncoded, maxEncoded, options);
  const loIdx = options.indexOf(range.minEncoded);
  const hiIdx = options.indexOf(range.maxEncoded);
  if (loIdx < 0 || hiIdx < 0) {
    return [];
  }
  return options.slice(loIdx, hiIdx + 1).map((encoded) => decodeAnilistSeasonEncoded(encoded));
}

export function resolveWeeklyCalendarSeasonSpecs(
  form: Pick<
    WeeklyCalendarForm,
    'seasonScope' | 'customSeasonMinEncoded' | 'customSeasonMaxEncoded'
  >,
  now: Date = new Date(),
): AnilistSeasonAt[] | null {
  if (form.seasonScope === 'watching') {
    return null;
  }
  const current = getCurrentAnilistSeason(now);
  if (form.seasonScope === 'next') {
    return [getNextAnilistSeason(current)];
  }
  if (form.seasonScope === 'current') {
    return [current];
  }
  const options = buildWeeklyCalendarCustomSeasonYearOptions(now);
  return enumerateCustomSeasonSpecs(
    form.customSeasonMinEncoded,
    form.customSeasonMaxEncoded,
    options,
  );
}

export function weeklyCalendarFetchKey(
  form: Pick<
    WeeklyCalendarForm,
    'seasonScope' | 'customSeasonMinEncoded' | 'customSeasonMaxEncoded'
  >,
): string {
  if (form.seasonScope === 'watching') {
    return 'watching';
  }
  if (form.seasonScope === 'current') {
    return 'current';
  }
  if (form.seasonScope === 'next') {
    return 'next';
  }
  return `custom:${form.customSeasonMinEncoded}:${form.customSeasonMaxEncoded}`;
}

export function isWeeklyCalendarSeasonScope(
  scope: WeeklyCalendarSeasonScope,
): scope is 'current' | 'next' | 'custom' {
  return scope === 'current' || scope === 'next' || scope === 'custom';
}

export function formatAnilistSeasonLabel(spec: AnilistSeasonAt): string {
  const name = spec.season[0] + spec.season.slice(1).toLowerCase();
  return `${name} ${spec.year}`;
}

export function formatAnilistSeasonRangeLabel(
  minSpec: AnilistSeasonAt,
  maxSpec: AnilistSeasonAt,
): string {
  const minLabel = formatAnilistSeasonLabel(minSpec);
  const maxLabel = formatAnilistSeasonLabel(maxSpec);
  if (minSpec.season === maxSpec.season && minSpec.year === maxSpec.year) {
    return minLabel;
  }
  return `${minLabel} - ${maxLabel}`;
}

export function isWeeklyCalendarWatchingListStatus(status: string | null | undefined): boolean {
  return status === 'CURRENT' || status === 'REPEATING';
}

function calendarKeyToIso(key: number): string {
  const year = Math.floor(key / 10_000);
  const month = Math.floor((key % 10_000) / 100);
  const day = key % 100;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatFuzzyDateIso(date: SeasonalFuzzyDate | null | undefined): string | null {
  const key = fuzzyDateToCalendarKey(date, 'start');
  return key == null ? null : calendarKeyToIso(key);
}

export function computeAiredEpisodeCount(
  nextEpisode: number | null | undefined,
  progress: number,
): number | null {
  if (nextEpisode != null && nextEpisode > 0) {
    return nextEpisode - 1;
  }
  return progress > 0 ? progress : null;
}

export function computeEpisodesLeft(
  totalEpisodes: number | null | undefined,
  progress: number,
): number | null {
  if (totalEpisodes == null || totalEpisodes <= 0) {
    return null;
  }
  const left = totalEpisodes - progress;
  return left > 0 ? left : null;
}

type ZonedParts = {
  weekdayJs: number;
  hour: number;
  minute: number;
};

function zonedPartsFromUnixSeconds(unixSeconds: number, timeZone: string | undefined): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(unixSeconds * 1000));
  const weekdayToken = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const weekdayJs = WEEKDAY_LABELS.findIndex(
    (label) => label.startsWith(weekdayToken),
  );
  return {
    weekdayJs: weekdayJs >= 0 ? weekdayJs : 0,
    hour,
    minute,
  };
}

export function inferWeekdayFromPastAirings(
  airingAts: readonly number[],
  timeZone: string | undefined,
  nowUnix: number,
): { weekdayJs: number; airingTimeMinutes: number } | null {
  const past = airingAts.filter((at) => at <= nowUnix);
  if (past.length === 0) {
    return null;
  }
  const weekdayCounts = new Map<number, number>();
  const timeByWeekday = new Map<number, number[]>();
  for (const at of past) {
    const { weekdayJs, hour, minute } = zonedPartsFromUnixSeconds(at, timeZone);
    weekdayCounts.set(weekdayJs, (weekdayCounts.get(weekdayJs) ?? 0) + 1);
    const times = timeByWeekday.get(weekdayJs) ?? [];
    times.push(hour * 60 + minute);
    timeByWeekday.set(weekdayJs, times);
  }
  let bestWeekday: number | null = null;
  let bestCount = -1;
  for (const [weekday, count] of weekdayCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestWeekday = weekday;
    }
  }
  if (bestWeekday == null) {
    return null;
  }
  const times = timeByWeekday.get(bestWeekday) ?? [];
  const airingTimeMinutes =
    times.length > 0
      ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length)
      : null;
  return {
    weekdayJs: bestWeekday,
    airingTimeMinutes: airingTimeMinutes ?? 0,
  };
}

export function resolveEntrySchedule(
  entry: Pick<
    WeeklyCalendarEntry,
    'nextAiringAt' | 'weekdayJs' | 'airingTimeMinutes' | 'inferredWeekday'
  >,
  pastAiringAts: readonly number[],
  timeZone: string | undefined,
  now: Date,
): Pick<WeeklyCalendarEntry, 'weekdayJs' | 'airingTimeMinutes' | 'inferredWeekday'> {
  if (entry.nextAiringAt != null) {
    const { weekdayJs, hour, minute } = zonedPartsFromUnixSeconds(
      entry.nextAiringAt,
      timeZone,
    );
    return {
      weekdayJs,
      airingTimeMinutes: hour * 60 + minute,
      inferredWeekday: false,
    };
  }
  const inferred = inferWeekdayFromPastAirings(
    pastAiringAts,
    timeZone,
    Math.floor(now.getTime() / 1000),
  );
  if (inferred) {
    return {
      weekdayJs: inferred.weekdayJs,
      airingTimeMinutes: inferred.airingTimeMinutes,
      inferredWeekday: true,
    };
  }
  return {
    weekdayJs: null,
    airingTimeMinutes: null,
    inferredWeekday: false,
  };
}

export function formatAiringTimeLabel(
  airingAtUnix: number,
  timeZone: string | undefined,
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(airingAtUnix * 1000));
}

export function formatWeeklyCalendarDateRange(
  startDate: SeasonalFuzzyDate | null | undefined,
  endDate: SeasonalFuzzyDate | null | undefined,
): string | null {
  const start = formatFuzzyDateIso(startDate);
  const end = formatFuzzyDateIso(endDate);
  if (!start && !end) {
    return null;
  }
  if (start && end) {
    return `${start} - ${end}`;
  }
  if (start) {
    return `${start} - ?`;
  }
  return `? - ${end}`;
}

export type WeeklyCalendarDetailLines = {
  primary: string | null;
  episodesLeft: string | null;
  secondary: string | null;
};

export function formatWeeklyCalendarTimeLine(
  entry: Pick<
    WeeklyCalendarEntry,
    'nextAiringAt' | 'airingTimeMinutes' | 'inferredWeekday'
  >,
  timeZone: string | undefined,
): string | null {
  if (entry.nextAiringAt != null) {
    return formatAiringTimeLabel(entry.nextAiringAt, timeZone);
  }
  if (entry.airingTimeMinutes != null && entry.inferredWeekday) {
    const hours = Math.floor(entry.airingTimeMinutes / 60);
    const minutes = entry.airingTimeMinutes % 60;
    return `~${new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(2000, 0, 1, hours, minutes))}`;
  }
  return null;
}

export function formatWeeklyCalendarEpisodeProgress(
  progress: number,
  totalEpisodes: number | null | undefined,
): string | null {
  const hasTotal = totalEpisodes != null && totalEpisodes > 0;
  if (progress <= 0 && !hasTotal) {
    return null;
  }
  const denominator = hasTotal ? String(totalEpisodes) : '?';
  return `ep ${progress}/${denominator}`;
}

export function formatWeeklyCalendarDetailLines(
  entry: WeeklyCalendarEntry,
  timeZone: string | undefined,
): WeeklyCalendarDetailLines {
  const parts: string[] = [];
  const episodeProgress = formatWeeklyCalendarEpisodeProgress(
    entry.progress,
    entry.totalEpisodes,
  );
  if (episodeProgress) {
    parts.push(episodeProgress);
  }
  const dateRange = formatWeeklyCalendarDateRange(entry.startDate, entry.endDate);
  if (dateRange) {
    parts.push(dateRange);
  }
  const left = computeEpisodesLeft(entry.totalEpisodes, entry.progress);
  return {
    primary: parts.length > 0 ? parts.join(', ') : null,
    episodesLeft: left != null ? `${left} episodes left` : null,
    secondary: formatWeeklyCalendarTimeLine(entry, timeZone),
  };
}

/** @deprecated Use formatWeeklyCalendarDetailLines */
export function formatWeeklyCalendarDetailLine(
  entry: WeeklyCalendarEntry,
  timeZone: string | undefined,
): string {
  const { primary, episodesLeft, secondary } = formatWeeklyCalendarDetailLines(
    entry,
    timeZone,
  );
  const lines = [primary, episodesLeft, secondary].filter(
    (line): line is string => line != null && line.length > 0,
  );
  return lines.join('\n');
}

function listStatusSortTier(listStatus: string | null): number {
  if (listStatus == null) {
    return 5;
  }
  if (listStatus === 'CURRENT' || listStatus === 'REPEATING') {
    return 1;
  }
  if (listStatus === 'PLANNING') {
    return 2;
  }
  if (listStatus === 'PAUSED') {
    return 3;
  }
  return 4;
}

export function compareWeeklyCalendarClassicOrder(
  a: WeeklyCalendarEntry,
  b: WeeklyCalendarEntry,
): number {
  const scoreA = normalizeSeasonalListScore(a.score);
  const scoreB = normalizeSeasonalListScore(b.score);
  if (scoreA != null && scoreB != null) {
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    return (b.popularity ?? 0) - (a.popularity ?? 0);
  }
  if (scoreA != null) {
    return -1;
  }
  if (scoreB != null) {
    return 1;
  }
  const tierA = listStatusSortTier(a.listStatus);
  const tierB = listStatusSortTier(b.listStatus);
  if (tierA !== tierB) {
    return tierA - tierB;
  }
  return (b.popularity ?? 0) - (a.popularity ?? 0);
}

export function compareWeeklyCalendarWatchingOrder(
  a: WeeklyCalendarEntry,
  b: WeeklyCalendarEntry,
): number {
  const timeA = a.airingTimeMinutes;
  const timeB = b.airingTimeMinutes;
  if (timeA != null && timeB != null && timeA !== timeB) {
    return timeA - timeB;
  }
  if (timeA != null && timeB == null) {
    return -1;
  }
  if (timeA == null && timeB != null) {
    return 1;
  }
  const scoreA = normalizeSeasonalListScore(a.score);
  const scoreB = normalizeSeasonalListScore(b.score);
  if (scoreA != null && scoreB != null && scoreB !== scoreA) {
    return scoreB - scoreA;
  }
  if (scoreA != null && scoreB == null) {
    return -1;
  }
  if (scoreA == null && scoreB != null) {
    return 1;
  }
  return a.title.localeCompare(b.title);
}

export function orderedWeekdayColumns(
  weekStartDay: WeeklyCalendarWeekStartDay,
): Array<{ key: string; label: string; weekdayJs: number }> {
  const startJs = JS_WEEKDAY_BY_START[weekStartDay];
  const out: Array<{ key: string; label: string; weekdayJs: number }> = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const weekdayJs = (startJs + offset) % 7;
    out.push({
      key: String(weekdayJs),
      label: WEEKDAY_LABELS[weekdayJs]!,
      weekdayJs,
    });
  }
  return out;
}

export type BuildWeeklyCalendarColumnsOptions = {
  weekStartDay: WeeklyCalendarWeekStartDay;
  showUnscheduledColumn: boolean;
  seasonMode: boolean;
};

/** Internal fetch shape — stripped before render. */
export type WeeklyCalendarRawEntry = WeeklyCalendarEntry & {
  pastAiringAts?: number[];
  nextAiringEpisodeNumber?: number | null;
};

export function buildWeeklyCalendarColumns(
  entries: readonly WeeklyCalendarEntry[],
  options: BuildWeeklyCalendarColumnsOptions,
): WeeklyCalendarColumn[] {
  const compare = options.seasonMode
    ? compareWeeklyCalendarClassicOrder
    : compareWeeklyCalendarWatchingOrder;
  const columns: WeeklyCalendarColumn[] = orderedWeekdayColumns(options.weekStartDay).map(
    (col) => ({
      ...col,
      shows: [],
    }),
  );
  const unscheduled: WeeklyCalendarEntry[] = [];

  for (const entry of entries) {
    if (entry.weekdayJs == null) {
      unscheduled.push(entry);
      continue;
    }
    const column = columns.find((col) => col.weekdayJs === entry.weekdayJs);
    if (column) {
      column.shows.push(entry);
    } else {
      unscheduled.push(entry);
    }
  }

  for (const column of columns) {
    column.shows.sort(compare);
  }
  unscheduled.sort(compare);

  if (options.showUnscheduledColumn && unscheduled.length > 0) {
    columns.push({
      key: 'unscheduled',
      label: 'Unknown',
      weekdayJs: null,
      shows: unscheduled,
    });
  }

  return columns;
}

export function finalizeWeeklyCalendarResult(
  entries: readonly WeeklyCalendarRawEntry[],
  form: WeeklyCalendarForm,
  seasonLabel: string | null,
  now: Date = new Date(),
): WeeklyCalendarResult {
  const seasonMode = isWeeklyCalendarSeasonScope(form.seasonScope);
  const filtered = entries.filter(
    (entry) =>
      entryMatchesWeeklyListStatusFilters(entry.listStatus, form.listStatusFilters) &&
      entryMatchesWeeklyMediaStatusFilters(entry.mediaStatus, form.mediaStatusFilters),
  );

  if (filtered.length === 0) {
    const scope = seasonMode
      ? `No shows found for ${seasonLabel ?? 'the selected season'} with the selected list and airing statuses.`
      : 'No shows on the list match the selected list and airing statuses.';
    return { kind: 'empty', message: scope };
  }

  const timeZone = weeklyCalendarTimezoneToIana(form.timezone);
  const resolved: WeeklyCalendarEntry[] = filtered.map((entry) => {
    const { pastAiringAts, nextAiringEpisodeNumber, ...rest } = entry;
    const schedule = resolveEntrySchedule(entry, pastAiringAts ?? [], timeZone, now);
    return {
      ...rest,
      ...schedule,
      airedCount:
        rest.airedCount ??
        computeAiredEpisodeCount(nextAiringEpisodeNumber ?? null, rest.progress),
    };
  });

  const columns = buildWeeklyCalendarColumns(resolved, {
    weekStartDay: form.weekStartDay,
    showUnscheduledColumn: form.showUnscheduledColumn,
    seasonMode,
  });

  const hasShows = columns.some((col) => col.shows.length > 0);
  if (!hasShows) {
    return {
      kind: 'empty',
      message: form.showUnscheduledColumn
        ? 'No scheduled shows to display.'
        : 'No shows with a known airing day — enable the Unknown column.',
    };
  }

  return { kind: 'columns', columns, seasonLabel };
}

export function collectWeeklyCalendarMediaIds(
  result: Extract<WeeklyCalendarResult, { kind: 'columns' }>,
): number[] {
  const ids = new Set<number>();
  for (const col of result.columns) {
    for (const show of col.shows) {
      ids.add(show.id);
    }
  }
  return [...ids];
}

export function collectWeeklyCalendarShows(
  result: Extract<WeeklyCalendarResult, { kind: 'columns' }>,
): WeeklyCalendarEntry[] {
  const byId = new Map<number, WeeklyCalendarEntry>();
  for (const col of result.columns) {
    for (const show of col.shows) {
      byId.set(show.id, show);
    }
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}
