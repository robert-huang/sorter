import { encodeSeasonYear } from '../../lib/importers/anilist/filters';
import { anilistMediaSourceLabel } from '../../lib/importers/anilist/mediaSourceLabel';
import { parseLinesOnePerLine } from '../parseToolLines';
import type { AnilistMediaSeason, AnilistMediaSource } from '../../lib/importers/anilist/types';
import { ALL_ANILIST_MEDIA_SOURCES } from '../../lib/importers/anilist/types';

export type SeasonalFuzzyDate = {
  year: number | null;
  month: number | null;
  day: number | null;
};

export type SeasonalShow = {
  id: number;
  title: string;
  titleSource?: import('../../lib/importers/anilist/mediaDisplayLabel').MediaTitleFields;
  coverImage?: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate?: SeasonalFuzzyDate | null;
  endDate?: SeasonalFuzzyDate | null;
  score: number | null;
  notes: string | null;
  /** AniList list status (e.g. PLANNING when include-planning fetch is enabled). */
  listStatus?: string | null;
  /** AniList MediaSource (ORIGINAL, LIGHT_NOVEL, …) — null when not yet imported. */
  source?: AnilistMediaSource | null;
};

export type SeasonSpec = {
  label: string;
  season: string | null;
  year: number;
  /** Single merged column across the full list (ignores season/year matching). */
  matchAll?: boolean;
};

/**
 * `all` / `allseasons` substitute a fixed magic seasonText so the user can pick
 * a sensible default without typing. `custom` falls through to whatever they
 * type in the textarea (the existing free-form input).
 */
export type SeasonMode = 'alltime' | 'all' | 'allseasons' | 'custom';

/** One chip option per AniList MediaSource value. */
export const SEASONAL_SOURCE_FILTER_KEYS = ALL_ANILIST_MEDIA_SOURCES;

export type SeasonalSourceFilterKey = AnilistMediaSource;

/** @deprecated Pre–full-enum source chip set; used to migrate “all selected” saves. */
const LEGACY_SEASONAL_SOURCE_FILTER_KEYS = [
  'ORIGINAL',
  'MANGA',
  'LIGHT_NOVEL',
  'VISUAL_NOVEL',
  'NOVEL',
  'VIDEO_GAME',
  'OTHER',
] as const satisfies readonly AnilistMediaSource[];

/** Selected adaptation-source buckets (same chip model as list-status filters). */
export type SeasonalSourceFilters = SeasonalSourceFilterKey[];

export const DEFAULT_SEASONAL_SOURCE_FILTERS: SeasonalSourceFilters = [
  ...SEASONAL_SOURCE_FILTER_KEYS,
];

/** Coerce persisted/localStorage values into a valid source selection. */
export function normalizeSeasonalSourceFilters(raw: unknown): SeasonalSourceFilters {
  if (Array.isArray(raw)) {
    let selected = SEASONAL_SOURCE_FILTER_KEYS.filter((key) => raw.includes(key));
    const hadFullLegacySet = LEGACY_SEASONAL_SOURCE_FILTER_KEYS.every((key) =>
      raw.includes(key),
    );
    if (hadFullLegacySet) {
      for (const key of SEASONAL_SOURCE_FILTER_KEYS) {
        if (!selected.includes(key)) {
          selected = [...selected, key];
        }
      }
    }
    return selected.length > 0 ? selected : [...DEFAULT_SEASONAL_SOURCE_FILTERS];
  }
  if (raw && typeof raw === 'object') {
    // Legacy boolean-map shape from the first checkbox bar.
    const parsed = raw as Partial<Record<SeasonalSourceFilterKey, boolean>>;
    const selected = SEASONAL_SOURCE_FILTER_KEYS.filter((key) => parsed[key] !== false);
    return selected.length > 0 ? [...selected] : [...DEFAULT_SEASONAL_SOURCE_FILTERS];
  }
  return [...DEFAULT_SEASONAL_SOURCE_FILTERS];
}

const KNOWN_SEASONAL_SOURCE_KEYS = new Set<string>(SEASONAL_SOURCE_FILTER_KEYS);

export function seasonalSourceFilterLabel(key: SeasonalSourceFilterKey): string {
  return anilistMediaSourceLabel(key);
}

export function seasonalSourceFilterBucket(
  source: AnilistMediaSource | null | undefined,
): SeasonalSourceFilterKey {
  if (source && KNOWN_SEASONAL_SOURCE_KEYS.has(source)) {
    return source;
  }
  return 'OTHER';
}

export function isAllSeasonalSourcesSelected(selected: SeasonalSourceFilters): boolean {
  if (selected.length < SEASONAL_SOURCE_FILTER_KEYS.length) {
    return false;
  }
  const allowed = new Set(selected);
  return SEASONAL_SOURCE_FILTER_KEYS.every((key) => allowed.has(key));
}

export function applySeasonalSourceFilters(
  shows: SeasonalShow[],
  selected: SeasonalSourceFilters,
): SeasonalShow[] {
  if (selected.length === 0) {
    return [];
  }
  if (isAllSeasonalSourcesSelected(selected)) {
    return shows;
  }
  const allowed = new Set(selected);
  return shows.filter((show) => allowed.has(seasonalSourceFilterBucket(show.source)));
}

/** AniList list statuses on the status chip — PLANNING is excluded; use Include Planning. */
export const SEASONAL_LIST_STATUS_OPTIONS = [
  'COMPLETED',
  'CURRENT',
  'REPEATING',
  'PAUSED',
] as const;

export type SeasonalListStatus = (typeof SEASONAL_LIST_STATUS_OPTIONS)[number];

export type SeasonalListStatusFilters = SeasonalListStatus[];

export const DEFAULT_SEASONAL_LIST_STATUS_FILTERS: SeasonalListStatusFilters = [
  ...SEASONAL_LIST_STATUS_OPTIONS,
];

/** Coerce persisted/localStorage values into a valid list-status selection. */
export function normalizeSeasonalListStatusFilters(raw: unknown): SeasonalListStatusFilters {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_SEASONAL_LIST_STATUS_FILTERS];
  }
  const selected = SEASONAL_LIST_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_SEASONAL_LIST_STATUS_FILTERS];
}

export function isAllSeasonalListStatusesSelected(
  selected: SeasonalListStatusFilters,
): boolean {
  if (selected.length < SEASONAL_LIST_STATUS_OPTIONS.length) {
    return false;
  }
  const allowed = new Set(selected);
  return SEASONAL_LIST_STATUS_OPTIONS.every((status) => allowed.has(status));
}

export function applySeasonalListStatusFilters(
  shows: SeasonalShow[],
  selected: SeasonalListStatusFilters,
): SeasonalShow[] {
  if (selected.length === 0) {
    return [];
  }
  if (isAllSeasonalListStatusesSelected(selected)) {
    return shows;
  }
  const allowed = new Set<string>(selected);
  return shows.filter((show) => {
    // Planning is gated by the Include Planning checkbox in bucketShowsForSeason.
    if (show.listStatus === 'PLANNING') {
      return true;
    }
    const status = show.listStatus;
    return status != null && allowed.has(status);
  });
}

/** Encoded (season, seasonYear) for seasonYear range filtering — mirrors AniList import chips. */
export function encodeSeasonalShowSeasonYear(show: SeasonalShow): number | null {
  const season = show.season;
  const year = show.seasonYear;
  if (season == null || year == null) {
    return null;
  }
  if (season !== 'WINTER' && season !== 'SPRING' && season !== 'SUMMER' && season !== 'FALL') {
    return null;
  }
  return encodeSeasonYear(season as AnilistMediaSeason, year);
}

/** Distinct encoded season+year tuples in a show list, sorted ascending for the range chip. */
export function discoverSeasonalSeasonYearEncoded(shows: readonly SeasonalShow[]): number[] {
  const encoded = new Set<number>();
  for (const show of shows) {
    const value = encodeSeasonalShowSeasonYear(show);
    if (value != null) {
      encoded.add(value);
    }
  }
  return [...encoded].sort((a, b) => a - b);
}

export type SeasonalSeasonYearFilter = {
  seasonYearMin: number | null;
  seasonYearMax: number | null;
};

export const DEFAULT_SEASONAL_SEASON_YEAR_FILTER: SeasonalSeasonYearFilter = {
  seasonYearMin: null,
  seasonYearMax: null,
};

/** Coerce persisted/localStorage values into a valid seasonYear range. */
export function normalizeSeasonalSeasonYearFilter(raw: unknown): SeasonalSeasonYearFilter {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SEASONAL_SEASON_YEAR_FILTER };
  }
  const obj = raw as Record<string, unknown>;
  const seasonYearMin = typeof obj.seasonYearMin === 'number' ? obj.seasonYearMin : null;
  const seasonYearMax = typeof obj.seasonYearMax === 'number' ? obj.seasonYearMax : null;
  return { seasonYearMin, seasonYearMax };
}

export function isSeasonalSeasonYearFilterActive(filter: SeasonalSeasonYearFilter): boolean {
  return filter.seasonYearMin !== null || filter.seasonYearMax !== null;
}

export function applySeasonalSeasonYearFilters(
  shows: SeasonalShow[],
  filter: SeasonalSeasonYearFilter,
): SeasonalShow[] {
  if (!isSeasonalSeasonYearFilterActive(filter)) {
    return shows;
  }
  const { seasonYearMin, seasonYearMax } = filter;
  return shows.filter((show) => {
    const encoded = encodeSeasonalShowSeasonYear(show);
    if (encoded == null) {
      return false;
    }
    if (seasonYearMin !== null && encoded < seasonYearMin) {
      return false;
    }
    if (seasonYearMax !== null && encoded > seasonYearMax) {
      return false;
    }
    return true;
  });
}

/** Per-bucket show counts for source-filter chip labels (e.g. Original (12)). */
export function countSeasonalShowsBySourceBucket(
  shows: readonly SeasonalShow[],
): Record<SeasonalSourceFilterKey, number> {
  const counts = Object.fromEntries(
    SEASONAL_SOURCE_FILTER_KEYS.map((key) => [key, 0]),
  ) as Record<SeasonalSourceFilterKey, number>;
  for (const show of shows) {
    counts[seasonalSourceFilterBucket(show.source)] += 1;
  }
  return counts;
}

export type SeasonalScoresForm = {
  username: string;
  seasonText: string;
  seasonMode: SeasonMode;
  skipEmpty: boolean;
  airingNotesOnly: boolean;
  includePlanning: boolean;
  /** Bucket by broadcast start/end overlap instead of a single AniList season tag. */
  spanAiringSeasons: boolean;
};

/**
 * Resolve the form to what `buildSeasonalColumns` should actually parse.
 * The user's typed seasonText is preserved on the form object — we only
 * override `seasonText` for compute when `seasonMode` is a preset.
 */
export function effectiveSeasonalForm(form: SeasonalScoresForm): SeasonalScoresForm {
  if (form.seasonMode === 'alltime') {
    return { ...form, seasonText: 'alltime' };
  }
  if (form.seasonMode === 'all') {
    return { ...form, seasonText: 'all' };
  }
  if (form.seasonMode === 'allseasons') {
    return { ...form, seasonText: 'allseasons' };
  }
  return form;
}

export type SeasonColumn = {
  label: string;
  /** Carried through from the spec so the UI can build the matching AniList search URL. */
  season: string | null;
  year: number;
  matchAll?: boolean;
  ratedCount: number;
  average: number | null;
  shows: Array<{
    id: number;
    title: string;
    coverImage: string | null;
    score: number | null;
    listStatus?: string | null;
    /** Span mode: placed via airing overlap, not the show's AniList season tag. */
    extendedPlacement?: boolean;
  }>;
};

export type SeasonalScoresResult =
  | { kind: 'empty'; message: string }
  | { kind: 'columns'; columns: SeasonColumn[] };

const SEASON_NAMES = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;

/** AniList POINT_100 list scores use 0 for "not rated". */
export function normalizeSeasonalListScore(score: number | null | undefined): number | null {
  if (score == null || score <= 0) {
    return null;
  }
  return score;
}

export type ScoreDisplayTone = 'high' | 'low';

/** Text colour for scored list entries: >80 green, <70 pink. */
export function scoreDisplayTone(
  score: number | null | undefined,
): ScoreDisplayTone | null {
  const normalized = normalizeSeasonalListScore(score);
  if (normalized == null) {
    return null;
  }
  if (normalized > 80) {
    return 'high';
  }
  if (normalized < 70) {
    return 'low';
  }
  return null;
}

export function scoreDisplayToneClass(score: number | null | undefined): string {
  const tone = scoreDisplayTone(score);
  return tone == null ? '' : `tool-score-tone--${tone}`;
}

export function isSeasonalPlanningShow(show: Pick<SeasonalShow, 'listStatus'>): boolean {
  return show.listStatus === 'PLANNING';
}

/** Status letter shown in chart cells when on-list but unrated. */
export function listStatusScoreLabel(
  listStatus: string | null | undefined,
  score: number | null | undefined,
  mediaType?: string | null,
): 'P' | 'W' | 'R' | 'H' | null {
  if (normalizeSeasonalListScore(score) != null) {
    return null;
  }
  if (listStatus === 'PLANNING') {
    return 'P';
  }
  if (listStatus === 'CURRENT' || listStatus === 'REPEATING') {
    return mediaType === 'MANGA' ? 'R' : 'W';
  }
  if (listStatus === 'PAUSED') {
    return 'H';
  }
  return null;
}

export function isSeasonalStatusLetterShow(
  show: Pick<SeasonalShow, 'listStatus' | 'score'>,
): boolean {
  return listStatusScoreLabel(show.listStatus, show.score) != null;
}

export function formatSeasonalScoreLabel(
  score: number | null | undefined,
  listStatus?: string | null,
): string {
  const statusLabel = listStatusScoreLabel(listStatus, score);
  if (statusLabel != null) {
    return statusLabel;
  }
  const normalized = normalizeSeasonalListScore(score);
  return normalized == null ? '—' : String(normalized);
}

export function countRatedSeasonalShows(shows: SeasonalShow[]): number {
  return shows.reduce((count, show) => {
    if (isSeasonalStatusLetterShow(show)) {
      return count;
    }
    return count + (normalizeSeasonalListScore(show.score) == null ? 0 : 1);
  }, 0);
}

function seasonalShowSortKey(show: SeasonalShow): number {
  const statusLabel = listStatusScoreLabel(show.listStatus, show.score);
  if (statusLabel === 'W' || statusLabel === 'R') {
    return -1;
  }
  if (statusLabel === 'H') {
    return -2;
  }
  if (statusLabel === 'P') {
    return -3;
  }
  return normalizeSeasonalListScore(show.score) ?? 0;
}

export function formatSeasonColumnLabel(label: string, ratedCount: number): string {
  return `${label} (${ratedCount})`;
}

export function parseSeasonLine(line: string): { season: string | null; year: number } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const yearToken = parts[parts.length - 1];
  const year = Number.parseInt(yearToken, 10);
  if (!Number.isFinite(year)) {
    return null;
  }
  if (parts.length === 1) {
    return { season: null, year };
  }
  let season = parts.slice(0, -1).join(' ').toUpperCase();
  if (season === 'AUTUMN') {
    season = 'FALL';
  }
  return { season, year };
}

export function parseSeasonSpecs(
  text: string,
  shows: SeasonalShow[],
): SeasonSpec[] {
  const lines = parseLinesOnePerLine(text);

  if (lines.length === 0) {
    return [];
  }

  const years = shows
    .map((s) => s.seasonYear)
    .filter((y): y is number => y !== null && y > 0);
  // No current-year fallback when the user has no usable seasonYear values
  // (empty list, list fetch returned `data: null`, user with only movies).
  // The previous fallback to `new Date().getFullYear()` silently rendered a
  // 2026-only chart that looked broken; surfacing zero specs instead lets
  // `buildSeasonalColumns` emit the empty-state message.
  const minYear = years.length > 0 ? Math.min(...years) : null;
  const maxYear = years.length > 0 ? Math.max(...years) : null;
  const hasRange = minYear !== null && maxYear !== null;

  const specs: SeasonSpec[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower === 'alltime') {
      specs.push({ label: 'All Time', season: null, year: 0, matchAll: true });
      continue;
    }
    if (lower === 'all') {
      if (!hasRange) {
        continue;
      }
      for (let year = minYear; year <= maxYear; year += 1) {
        specs.push({ label: String(year), season: null, year });
      }
      continue;
    }
    if (lower === 'allseasons') {
      if (!hasRange) {
        continue;
      }
      for (let year = minYear; year <= maxYear; year += 1) {
        for (const season of SEASON_NAMES) {
          const label = `${season[0]}${season.slice(1).toLowerCase()} ${year}`;
          specs.push({ label, season, year });
        }
      }
      continue;
    }

    const parsed = parseSeasonLine(line);
    if (!parsed) {
      continue;
    }
    const label =
      parsed.season === null
        ? String(parsed.year)
        : `${parsed.season[0]}${parsed.season.slice(1).toLowerCase()} ${parsed.year}`;
    specs.push({ label, season: parsed.season, year: parsed.year });
  }

  return specs;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function calendarDateKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

/** Resolve an AniList fuzzy date to an inclusive calendar bound. */
export function fuzzyDateToCalendarKey(
  date: SeasonalFuzzyDate | null | undefined,
  bound: 'start' | 'end',
): number | null {
  if (!date || date.year == null) {
    return null;
  }
  const year = date.year;
  if (date.month == null) {
    return bound === 'start'
      ? calendarDateKey(year, 1, 1)
      : calendarDateKey(year, 12, 31);
  }
  const month = date.month;
  if (date.day == null) {
    return bound === 'start'
      ? calendarDateKey(year, month, 1)
      : calendarDateKey(year, month, daysInMonth(year, month));
  }
  return calendarDateKey(year, month, date.day);
}

function nowCalendarKey(now: Date): number {
  return calendarDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export type AiringInterval = {
  start: number;
  end: number;
};

/** Broadcast range; missing end extends through `now`. */
export function resolveShowAiringInterval(
  show: Pick<SeasonalShow, 'startDate' | 'endDate'>,
  now: Date,
): AiringInterval | null {
  const start = fuzzyDateToCalendarKey(show.startDate, 'start');
  if (start == null) {
    return null;
  }
  const end = fuzzyDateToCalendarKey(show.endDate, 'end') ?? nowCalendarKey(now);
  return { start, end: Math.max(start, end) };
}

function intervalsOverlap(a: AiringInterval, b: AiringInterval): boolean {
  return a.start <= b.end && a.end >= b.start;
}

type AnilistSeasonName = (typeof SEASON_NAMES)[number];

function parseCalendarKey(key: number): { year: number; month: number; day: number } {
  return {
    year: Math.floor(key / 10_000),
    month: Math.floor((key % 10_000) / 100),
    day: key % 100,
  };
}

function addDaysToCalendarKey(key: number, deltaDays: number): number {
  const { year, month, day } = parseCalendarKey(key);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + deltaDays);
  return calendarDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function anilistSeasonAt(key: number): { season: AnilistSeasonName; year: number } {
  const { year, month } = parseCalendarKey(key);
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

function firstDayOfNextAnilistSeason(
  season: AnilistSeasonName,
  year: number,
): number {
  switch (season) {
    case 'WINTER':
      return calendarDateKey(year, 4, 1);
    case 'SPRING':
      return calendarDateKey(year, 7, 1);
    case 'SUMMER':
      return calendarDateKey(year, 10, 1);
    case 'FALL':
      return calendarDateKey(year + 1, 1, 1);
  }
}

function lastDayOfPreviousAnilistSeason(
  season: AnilistSeasonName,
  year: number,
): number {
  switch (season) {
    case 'WINTER':
      return calendarDateKey(year - 1, 12, 31);
    case 'SPRING':
      return calendarDateKey(year, 3, 31);
    case 'SUMMER':
      return calendarDateKey(year, 6, 30);
    case 'FALL':
      return calendarDateKey(year, 9, 30);
  }
}

function isInLastWeekOfItsSeason(key: number): boolean {
  const { season, year } = anilistSeasonAt(key);
  const bounds = seasonSpecCalendarInterval({ label: '', season, year });
  const lastWeekStart = addDaysToCalendarKey(bounds.end, -6);
  return key >= lastWeekStart && key <= bounds.end;
}

function isInFirstWeekOfItsSeason(key: number): boolean {
  const { season, year } = anilistSeasonAt(key);
  const bounds = seasonSpecCalendarInterval({ label: '', season, year });
  const firstWeekEnd = addDaysToCalendarKey(bounds.start, 6);
  return key >= bounds.start && key <= firstWeekEnd;
}

/**
 * Trim boundary leakage: starts in the last week of a season don't count
 * toward that season; ends in the first week don't count toward that season.
 */
export function clampAiringIntervalSeasonBoundaries(
  interval: AiringInterval,
): AiringInterval | null {
  let { start, end } = interval;

  if (isInLastWeekOfItsSeason(start)) {
    const { season, year } = anilistSeasonAt(start);
    start = firstDayOfNextAnilistSeason(season, year);
  }
  if (isInFirstWeekOfItsSeason(end)) {
    const { season, year } = anilistSeasonAt(end);
    end = lastDayOfPreviousAnilistSeason(season, year);
  }

  if (start > end) {
    return null;
  }
  return { start, end };
}

/** AniList season calendar windows (inclusive). */
export function seasonSpecCalendarInterval(spec: SeasonSpec): AiringInterval {
  if (spec.season === null) {
    return {
      start: calendarDateKey(spec.year, 1, 1),
      end: calendarDateKey(spec.year, 12, 31),
    };
  }
  switch (spec.season) {
    case 'WINTER':
      return {
        start: calendarDateKey(spec.year, 1, 1),
        end: calendarDateKey(spec.year, 3, 31),
      };
    case 'SPRING':
      return {
        start: calendarDateKey(spec.year, 4, 1),
        end: calendarDateKey(spec.year, 6, 30),
      };
    case 'SUMMER':
      return {
        start: calendarDateKey(spec.year, 7, 1),
        end: calendarDateKey(spec.year, 9, 30),
      };
    case 'FALL':
      return {
        start: calendarDateKey(spec.year, 10, 1),
        end: calendarDateKey(spec.year, 12, 31),
      };
    default:
      return {
        start: calendarDateKey(spec.year, 1, 1),
        end: calendarDateKey(spec.year, 12, 31),
      };
  }
}

function matchesSeasonYearAndTag(
  show: Pick<SeasonalShow, 'season' | 'seasonYear'>,
  spec: SeasonSpec,
): boolean {
  if (show.seasonYear !== spec.year) {
    return false;
  }
  if (spec.season && show.season !== spec.season) {
    return false;
  }
  return true;
}

/** Span mode: faded when this column is an extra season beyond the show's tagged slot. */
export function showAppearsInTaggedSeasonColumn(
  show: SeasonalShow,
  specs: SeasonSpec[],
  options: { spanAiringSeasons: boolean; now: Date },
): boolean {
  if (show.seasonYear == null) {
    return false;
  }
  for (const taggedSpec of specs) {
    if (!matchesSeasonYearAndTag(show, taggedSpec)) {
      continue;
    }
    if (showMatchesSeasonSpec(show, taggedSpec, options)) {
      return true;
    }
  }
  return false;
}

export function isExtendedSeasonPlacement(
  show: SeasonalShow,
  spec: SeasonSpec,
  spanAiringSeasons: boolean,
  appearsInTaggedSeasonColumn: boolean,
): boolean {
  if (!spanAiringSeasons || matchesSeasonYearAndTag(show, spec)) {
    return false;
  }
  return appearsInTaggedSeasonColumn;
}

export function showMatchesSeasonSpec(
  show: SeasonalShow,
  spec: SeasonSpec,
  options: { spanAiringSeasons: boolean; now: Date },
): boolean {
  if (spec.matchAll) {
    return true;
  }
  if (!options.spanAiringSeasons) {
    return matchesSeasonYearAndTag(show, spec);
  }
  const airing = resolveShowAiringInterval(show, options.now);
  if (airing == null) {
    return matchesSeasonYearAndTag(show, spec);
  }
  const clamped = clampAiringIntervalSeasonBoundaries(airing);
  if (clamped == null) {
    return matchesSeasonYearAndTag(show, spec);
  }
  return intervalsOverlap(clamped, seasonSpecCalendarInterval(spec));
}

export function bucketShowsForSeason(
  shows: SeasonalShow[],
  spec: SeasonSpec,
  airingNotesOnly: boolean,
  includePlanning: boolean,
  spanAiringSeasons: boolean,
  now: Date = new Date(),
): SeasonalShow[] {
  return shows
    .filter((show) => {
      if (!includePlanning && isSeasonalPlanningShow(show)) {
        return false;
      }
      if (!showMatchesSeasonSpec(show, spec, { spanAiringSeasons, now })) {
        return false;
      }
      if (airingNotesOnly && !(show.notes ?? '').includes('#airing')) {
        return false;
      }
      return true;
    })
    .sort((a, b) => seasonalShowSortKey(b) - seasonalShowSortKey(a));
}

export function averageScore(shows: SeasonalShow[]): number | null {
  const scored = shows
    .filter((show) => !isSeasonalStatusLetterShow(show))
    .map((s) => normalizeSeasonalListScore(s.score))
    .filter((s): s is number => s !== null);
  if (scored.length === 0) {
    return null;
  }
  const sum = scored.reduce((acc, n) => acc + n, 0);
  return Math.round((sum / scored.length) * 1000) / 1000;
}

/** Column indices tied for the highest non-null average (empty when none rated). */
export function seasonColumnIndicesWithTopAverage(
  columns: ReadonlyArray<Pick<SeasonColumn, 'average'>>,
): Set<number> {
  let max: number | null = null;
  const indices: number[] = [];
  columns.forEach((col, index) => {
    if (col.average == null) {
      return;
    }
    if (max === null || col.average > max) {
      max = col.average;
      indices.length = 0;
      indices.push(index);
    } else if (col.average === max) {
      indices.push(index);
    }
  });
  return new Set(indices);
}

export type BuildSeasonalColumnsOptions = {
  /** Injectable clock for spanning-mode tests. */
  now?: Date;
  /** Client-side seasonYear range filter (instant toggle over cached shows). */
  seasonYearFilter?: SeasonalSeasonYearFilter;
  /** Client-side list-status filter (instant toggle over cached shows). */
  listStatusFilters?: SeasonalListStatusFilters;
  /** Client-side adaptation-source filter (instant toggle over cached shows). */
  sourceFilters?: SeasonalSourceFilters;
};

export function buildSeasonalColumns(
  shows: SeasonalShow[],
  form: SeasonalScoresForm,
  options?: BuildSeasonalColumnsOptions,
): SeasonalScoresResult {
  const now = options?.now ?? new Date();
  let filteredShows = applySeasonalSeasonYearFilters(
    shows,
    options?.seasonYearFilter ?? DEFAULT_SEASONAL_SEASON_YEAR_FILTER,
  );
  filteredShows = applySeasonalListStatusFilters(
    filteredShows,
    options?.listStatusFilters ?? DEFAULT_SEASONAL_LIST_STATUS_FILTERS,
  );
  filteredShows = applySeasonalSourceFilters(
    filteredShows,
    options?.sourceFilters ?? DEFAULT_SEASONAL_SOURCE_FILTERS,
  );
  const specs = parseSeasonSpecs(form.seasonText, filteredShows);
  if (specs.length === 0) {
    // Disambiguate so the user knows whether to type a season or
    // refresh — the `all`/`allseasons`/`alltime` presets only fail to emit specs
    // when the fetched list itself has no usable seasonYear values.
    const trimmed = form.seasonText.trim().toLowerCase();
    const isPreset =
      trimmed === 'alltime' || trimmed === 'all' || trimmed === 'allseasons';
    if (isPreset && shows.length === 0) {
      return {
        kind: 'empty',
        message:
          "AniList didn't return any list entries for this user — the list may be private or the response was empty. Right-click Compare to force a fresh fetch.",
      };
    }
    if (isPreset) {
      return {
        kind: 'empty',
        message:
          trimmed === 'alltime'
            ? 'No shows matched the current source filters.'
            : 'None of the fetched shows have a season/year — try the Custom mode and enter seasons manually.',
      };
    }
    return { kind: 'empty', message: 'Enter at least one season or year to compare.' };
  }

  const columns: SeasonColumn[] = [];
  const matchOptions = { spanAiringSeasons: form.spanAiringSeasons, now };
  const appearsInTaggedSeasonById = new Map<number, boolean>();
  for (const show of filteredShows) {
    appearsInTaggedSeasonById.set(
      show.id,
      showAppearsInTaggedSeasonColumn(show, specs, matchOptions),
    );
  }

  for (const spec of specs) {
    const bucket = bucketShowsForSeason(
      filteredShows,
      spec,
      form.airingNotesOnly,
      form.includePlanning,
      form.spanAiringSeasons,
      now,
    );
    if (form.skipEmpty && bucket.length === 0) {
      continue;
    }
    columns.push({
      label: spec.label,
      season: spec.season,
      year: spec.year,
      matchAll: spec.matchAll,
      ratedCount: countRatedSeasonalShows(bucket),
      average: averageScore(bucket),
      shows: bucket.map((show) => ({
        id: show.id,
        title: show.title,
        coverImage: show.coverImage ?? null,
        score: normalizeSeasonalListScore(show.score),
        listStatus: show.listStatus ?? null,
        extendedPlacement: isExtendedSeasonPlacement(
          show,
          spec,
          form.spanAiringSeasons,
          appearsInTaggedSeasonById.get(show.id) ?? false,
        ),
      })),
    });
  }

  if (columns.length === 0) {
    return { kind: 'empty', message: 'No scored shows matched those seasons.' };
  }

  return { kind: 'columns', columns };
}
