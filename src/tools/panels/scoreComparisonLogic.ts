import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import { ALL_LIST_STATUSES } from '../../lib/importers/anilist/filters';
import { compareStatsSortValues } from './statsLogic';

export type ComparisonMediaType = 'ANIME' | 'MANGA';
export type ComparisonStat = 'mean' | 'stddev';
/** Stat menu choice; the normalized ones also switch every score to normalized values. */
export type ComparisonStatOption = ComparisonStat | 'normalizedMean' | 'normalizedStddev';

export const COMPARISON_STAT_OPTIONS: readonly ComparisonStatOption[] = [
  'mean',
  'stddev',
  'normalizedMean',
  'normalizedStddev',
];

export function isNormalizedStat(option: ComparisonStatOption): boolean {
  return option === 'normalizedMean' || option === 'normalizedStddev';
}

export function baseStat(option: ComparisonStatOption): ComparisonStat {
  return option === 'stddev' || option === 'normalizedStddev' ? 'stddev' : 'mean';
}
export type ComparisonScoreMode = 'any' | 'all';
export type ComparisonSortDirection = 'asc' | 'desc';
/** `title`, `stat`, or `user:<lowercased username>`. */
export type ComparisonSortColumn = string;

export type ComparisonEntry = {
  status: AnilistMediaListStatus;
  /** 0–100; 0 means unrated. */
  score: number;
};

export type ComparisonMedia = {
  id: number;
  title: string;
  coverImage: string | null;
};

export type ComparisonUserList = {
  /** Username as typed (column label); keyed lowercased. */
  username: string;
  entries: ReadonlyMap<number, ComparisonEntry>;
  favouriteMediaIds: ReadonlySet<number>;
};

export type UserListStats = { mean: number; stdDev: number; ratedCount: number };

export type ComparisonScoreFilter = {
  mode: ComparisonScoreMode;
  pill: 'any' | 'rated' | 'unrated';
  min: number | null;
  max: number | null;
};

export const DEFAULT_SCORE_FILTER: ComparisonScoreFilter = {
  mode: 'any',
  pill: 'any',
  min: null,
  max: null,
};

export type ComparisonFilters = {
  /** Keyed by lowercased username; missing key = all statuses. Kept after a user is removed. */
  userStatuses: Readonly<Record<string, readonly AnilistMediaListStatus[]>>;
  score: ComparisonScoreFilter;
  /** Null = no minimum. */
  minLists: number | null;
};

export type ComparisonCell = {
  entry: ComparisonEntry | null;
  /** On the list but filtered out by that user's status selection. */
  excluded: boolean;
  favourite: boolean;
};

export type ComparisonRow = {
  media: ComparisonMedia;
  cells: ComparisonCell[];
  /** Passes every per-user filter (status, score, min lists). */
  passes: boolean;
};

export function userKey(username: string): string {
  return username.trim().toLocaleLowerCase();
}

export function userSortColumn(username: string): ComparisonSortColumn {
  return `user:${userKey(username)}`;
}

export function statusesForUser(
  filters: Pick<ComparisonFilters, 'userStatuses'>,
  username: string,
): readonly AnilistMediaListStatus[] {
  return filters.userStatuses[userKey(username)] ?? ALL_LIST_STATUSES;
}

/** Empty or all-selected means every list status passes. */
export function cellPassesStatus(
  entry: ComparisonEntry,
  statuses: readonly AnilistMediaListStatus[],
): boolean {
  if (statuses.length === 0 || statuses.length >= ALL_LIST_STATUSES.length) {
    return true;
  }
  return statuses.includes(entry.status);
}

/** Mean and population std dev over rated entries of the whole list. */
export function userWholeListStats(
  entries: Iterable<ComparisonEntry>,
): UserListStats | null {
  const scores: number[] = [];
  for (const entry of entries) {
    if (entry.score > 0) scores.push(entry.score);
  }
  return meanAndStdDev(scores);
}

export type RescaleTarget = { mean: number; stdDev: number };

/**
 * Target mean / std dev that rescale one user's lowest and highest z-scores in the
 * passing rows onto [low, high], e.g. z from -3.03..2.07 → mean ≈ 59.4, std dev ≈ 19.6
 * for 0..100. Z-scores keep the whole-list baseline; only the fitted range follows filters.
 * Null when fewer than two distinct z-scores pass.
 */
export function fitRescaleTarget(
  rows: readonly ComparisonRow[],
  userIndex: number,
  stats: UserListStats | null,
  low = 0,
  high = 100,
): RescaleTarget | null {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const row of rows) {
    const cell = row.cells[userIndex];
    if (!row.passes || !cell || cell.excluded || !cell.entry) continue;
    const z = zScore(cell.entry.score, stats);
    if (z === null) continue;
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  if (!(zMax > zMin)) return null;
  const stdDev = (high - low) / (zMax - zMin);
  return { mean: low - zMin * stdDev, stdDev };
}

function meanAndStdDev(values: readonly number[]): UserListStats | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance), ratedCount: values.length };
}

/** Null when unrated, or when the user's scores have no spread. */
export function zScore(score: number, stats: UserListStats | null): number | null {
  if (score <= 0 || !stats || stats.stdDev === 0) return null;
  return (score - stats.mean) / stats.stdDev;
}

function isPassingCell(cell: ComparisonCell): cell is ComparisonCell & { entry: ComparisonEntry } {
  return cell.entry !== null && !cell.excluded;
}

function scoreInRange(score: number, filter: ComparisonScoreFilter): boolean {
  if (filter.min !== null && score < filter.min) return false;
  if (filter.max !== null && score > filter.max) return false;
  return true;
}

/** Single-user semantics from the sorter's score chip: range applies to rated only. */
function cellMatchesScore(entry: ComparisonEntry, filter: ComparisonScoreFilter): boolean {
  const rated = entry.score > 0;
  if (filter.pill === 'rated' && !rated) return false;
  if (filter.pill === 'unrated') return !rated;
  return !rated || scoreInRange(entry.score, filter);
}

function scoreFilterActive(filter: ComparisonScoreFilter): boolean {
  return filter.pill !== 'any' || filter.min !== null || filter.max !== null;
}

/**
 * `any` ("one person"): someone rated it in range; others may be unrated.
 * `all` ("everyone"): every passing user matches the score chip.
 */
export function rowPassesScoreRange(
  cells: readonly ComparisonCell[],
  filter: ComparisonScoreFilter,
): boolean {
  if (!scoreFilterActive(filter)) return true;
  const passing = cells.filter(isPassingCell);
  if (passing.length === 0) return false;
  if (filter.mode === 'all') {
    return passing.every((cell) => cellMatchesScore(cell.entry, filter));
  }
  if (filter.pill === 'unrated') {
    return passing.some((cell) => cell.entry.score <= 0);
  }
  return passing.some((cell) => cell.entry.score > 0 && scoreInRange(cell.entry.score, filter));
}

export function passingCellCount(cells: readonly ComparisonCell[]): number {
  return cells.filter(isPassingCell).length;
}

/** Empty `minLists` means the media must be on every user's list. */
export function rowPassesMinLists(
  cells: readonly ComparisonCell[],
  minLists: number | null,
): boolean {
  const count = passingCellCount(cells);
  return count > 0 && count >= Math.min(minLists ?? cells.length, cells.length);
}

/**
 * One row per media on any user's list. Every filter (media-level chips
 * via `allowedMediaIds`, and per-user ones) only sets `passes`; hiding is
 * left to `visibleComparisonRows` so "Show all rows" can keep everything.
 */
export function buildComparisonRows(
  users: readonly ComparisonUserList[],
  mediaById: ReadonlyMap<number, ComparisonMedia>,
  filters: ComparisonFilters,
  allowedMediaIds: ReadonlySet<number> | null,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  for (const media of mediaById.values()) {
    const mediaAllowed = !allowedMediaIds || allowedMediaIds.has(media.id);
    const cells = users.map((user): ComparisonCell => {
      const entry = user.entries.get(media.id) ?? null;
      return {
        entry,
        excluded: entry !== null && !cellPassesStatus(entry, statusesForUser(filters, user.username)),
        favourite: user.favouriteMediaIds.has(media.id),
      };
    });
    if (cells.every((cell) => cell.entry === null)) continue;
    const passes =
      mediaAllowed &&
      rowPassesMinLists(cells, filters.minLists) && rowPassesScoreRange(cells, filters.score);
    rows.push({ media, cells, passes });
  }
  return rows;
}

/** Rows to render: failing rows are kept only when "Show all rows" is on. */
export function visibleComparisonRows(
  rows: readonly ComparisonRow[],
  showAllRows: boolean,
): ComparisonRow[] {
  return showAllRows ? [...rows] : rows.filter((row) => row.passes);
}

/**
 * How cells are displayed: raw scores, z-scores, or z-scores mapped onto a
 * target scale (e.g. mean 70 / std dev 15 turns z = 1 into 85).
 */
export type ComparisonNormalization =
  | { kind: 'raw' }
  | { kind: 'z' }
  | { kind: 'rescaled'; mean: number; stdDev: number };

export const RAW_NORMALIZATION: ComparisonNormalization = { kind: 'raw' };

/** Displayed value of a cell under `normalization`. Null = no score. */
export function cellValue(
  cell: ComparisonCell,
  stats: UserListStats | null,
  normalization: ComparisonNormalization,
): number | null {
  if (!cell.entry || cell.entry.score <= 0) return null;
  if (normalization.kind === 'raw') return cell.entry.score;
  const z = zScore(cell.entry.score, stats);
  if (z === null || normalization.kind === 'z') return z;
  return normalization.mean + z * normalization.stdDev;
}

function passingValues(
  row: ComparisonRow,
  userStats: readonly (UserListStats | null)[],
  normalization: ComparisonNormalization,
): number[] {
  const values: number[] = [];
  row.cells.forEach((cell, index) => {
    if (cell.excluded) return;
    const value = cellValue(cell, userStats[index] ?? null, normalization);
    if (value !== null) values.push(value);
  });
  return values;
}

/**
 * Divides by the rated (passing) count; null when nobody rated it. Std dev also needs
 * two raters: one rating would read as a misleading 0 (null sorts last either way).
 */
export function rowStat(
  row: ComparisonRow,
  stat: ComparisonStat,
  userStats: readonly (UserListStats | null)[],
  normalization: ComparisonNormalization,
): number | null {
  const summary = meanAndStdDev(passingValues(row, userStats, normalization));
  if (!summary) return null;
  if (stat === 'mean') return summary.mean;
  return summary.ratedCount < 2 ? null : summary.stdDev;
}

/** Per-user mean / std dev of raw scores over passing rated cells in passing rows. */
export function userColumnSummaries(
  rows: readonly ComparisonRow[],
  userCount: number,
): (UserListStats | null)[] {
  const out: (UserListStats | null)[] = [];
  for (let index = 0; index < userCount; index += 1) {
    const values: number[] = [];
    for (const row of rows) {
      if (!row.passes) continue;
      const cell = row.cells[index];
      if (!cell || cell.excluded) continue;
      const value = cellValue(cell, null, RAW_NORMALIZATION);
      if (value !== null) values.push(value);
    }
    out.push(meanAndStdDev(values));
  }
  return out;
}

export type ComparisonSort = {
  column: ComparisonSortColumn;
  direction: ComparisonSortDirection;
};

export const DEFAULT_COMPARISON_SORT: ComparisonSort = { column: 'stat', direction: 'desc' };

/** Same cycling as Stats tables: new column starts desc (title asc), repeat flips. */
export function nextComparisonSort(
  prev: ComparisonSort,
  column: ComparisonSortColumn,
): ComparisonSort {
  if (prev.column !== column) {
    return { column, direction: column === 'title' ? 'asc' : 'desc' };
  }
  return { column, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
}

export type SortContext = {
  usernames: readonly string[];
  userStats: readonly (UserListStats | null)[];
  normalization: ComparisonNormalization;
  stat: ComparisonStat;
};

function sortValue(
  row: ComparisonRow,
  column: ComparisonSortColumn,
  ctx: SortContext,
): number | string | null {
  if (column === 'title') return row.media.title;
  if (column === 'stat') return rowStat(row, ctx.stat, ctx.userStats, ctx.normalization);
  const index = ctx.usernames.findIndex((name) => userSortColumn(name) === column);
  const cell = index >= 0 ? row.cells[index] : undefined;
  if (!cell || cell.excluded) return null;
  return cellValue(cell, ctx.userStats[index] ?? null, ctx.normalization);
}

/** Nulls always last; ties fall back to title. */
export function sortComparisonRows(
  rows: readonly ComparisonRow[],
  sort: ComparisonSort,
  ctx: SortContext,
): ComparisonRow[] {
  return [...rows].sort((a, b) => {
    const cmp = compareStatsSortValues(
      sortValue(a, sort.column, ctx),
      sortValue(b, sort.column, ctx),
      sort.direction,
    );
    return cmp !== 0 ? cmp : a.media.title.localeCompare(b.media.title);
  });
}

export function formatComparisonValue(
  value: number | null,
  normalization: ComparisonNormalization,
): string {
  if (value === null) return '';
  return normalization.kind === 'z' ? value.toFixed(2) : String(Math.round(value * 10) / 10);
}

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------

export const SCORE_COMPARISON_STORAGE_KEY = 'anime-tools-score-comparison-settings';

export type ScoreComparisonSettings = {
  usernames: string[];
  mediaType: ComparisonMediaType;
  chipState: Record<string, unknown> | null;
  filters: ComparisonFilters;
  sort: ComparisonSort;
  stat: ComparisonStatOption;
  showAllRows: boolean;
};

export const DEFAULT_SCORE_COMPARISON_SETTINGS: ScoreComparisonSettings = {
  usernames: [],
  mediaType: 'ANIME',
  chipState: null,
  filters: { userStatuses: {}, score: DEFAULT_SCORE_FILTER, minLists: null },
  sort: DEFAULT_COMPARISON_SORT,
  stat: 'mean',
  showAllRows: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : null;
}

function normalizeStatuses(value: unknown): AnilistMediaListStatus[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((s): s is AnilistMediaListStatus =>
    (ALL_LIST_STATUSES as readonly unknown[]).includes(s),
  );
}

function normalizeScoreFilter(value: unknown): ComparisonScoreFilter {
  if (!isRecord(value)) return DEFAULT_SCORE_FILTER;
  const pill = value.pill === 'rated' || value.pill === 'unrated' ? value.pill : 'any';
  return {
    mode: value.mode === 'all' ? 'all' : 'any',
    pill,
    min: pill === 'unrated' ? null : normalizeBound(value.min),
    max: pill === 'unrated' ? null : normalizeBound(value.max),
  };
}

function normalizeFilters(value: unknown): ComparisonFilters {
  if (!isRecord(value)) return DEFAULT_SCORE_COMPARISON_SETTINGS.filters;
  const userStatuses: Record<string, AnilistMediaListStatus[]> = {};
  if (isRecord(value.userStatuses)) {
    for (const [key, raw] of Object.entries(value.userStatuses)) {
      const statuses = normalizeStatuses(raw);
      if (statuses) userStatuses[key] = statuses;
    }
  }
  const minLists =
    typeof value.minLists === 'number' && Number.isInteger(value.minLists) && value.minLists > 0
      ? value.minLists
      : null;
  return { userStatuses, score: normalizeScoreFilter(value.score), minLists };
}

function normalizeSort(value: unknown): ComparisonSort {
  if (!isRecord(value) || typeof value.column !== 'string') return DEFAULT_COMPARISON_SORT;
  return {
    column: value.column,
    direction: value.direction === 'asc' ? 'asc' : 'desc',
  };
}

/** `legacyNormalized` maps the old separate "Normalized" checkbox onto the stat. */
function normalizeStatOption(value: unknown, legacyNormalized: boolean): ComparisonStatOption {
  if ((COMPARISON_STAT_OPTIONS as readonly unknown[]).includes(value)) {
    const option = value as ComparisonStatOption;
    if (!legacyNormalized || isNormalizedStat(option)) return option;
    return option === 'stddev' ? 'normalizedStddev' : 'normalizedMean';
  }
  return legacyNormalized ? 'normalizedMean' : 'mean';
}

export function normalizeScoreComparisonSettings(raw: unknown): ScoreComparisonSettings {
  if (!isRecord(raw)) return DEFAULT_SCORE_COMPARISON_SETTINGS;
  const seen = new Set<string>();
  const usernames = Array.isArray(raw.usernames)
    ? raw.usernames
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
        .filter((name) => {
          const key = userKey(name);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
    : [];
  return {
    usernames,
    mediaType: raw.mediaType === 'MANGA' ? 'MANGA' : 'ANIME',
    chipState: isRecord(raw.chipState) ? raw.chipState : null,
    filters: normalizeFilters(raw.filters),
    sort: normalizeSort(raw.sort),
    stat: normalizeStatOption(raw.stat, raw.normalized === true),
    showAllRows: raw.showAllRows === true,
  };
}

export function loadScoreComparisonSettings(): ScoreComparisonSettings {
  try {
    const raw = localStorage.getItem(SCORE_COMPARISON_STORAGE_KEY);
    return raw ? normalizeScoreComparisonSettings(JSON.parse(raw)) : DEFAULT_SCORE_COMPARISON_SETTINGS;
  } catch {
    return DEFAULT_SCORE_COMPARISON_SETTINGS;
  }
}

export function saveScoreComparisonSettings(settings: ScoreComparisonSettings): void {
  try {
    localStorage.setItem(SCORE_COMPARISON_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage full / disabled */
  }
}
