import type { TagFilterMode } from '../../lib/importers/anilist/filters';
import type { MediaTitleFields } from '../../lib/importers/anilist/mediaDisplayLabel';
import {
  KEY_ANIME_PRODUCTION_ROLES,
  KEY_MANGA_PRODUCTION_ROLES,
  isKeyProductionRole,
  normalizeProductionRoleForMatch,
} from '../../lib/importers/anilist/staffRoleFilter';
import type {
  AnilistCharacterRole,
  AnilistMediaFormat,
  AnilistMediaStatus,
  AnilistMediaType,
} from '../../lib/importers/anilist/types';
import { ALL_LIST_STATUSES } from '../../lib/importers/anilist/filters';
import {
  entryMatchesWeeklyScoreFilters,
  formatWeeklyCalendarFormatFilterLabel,
  formatWeeklyCalendarMediaStatusFilterLabel,
  normalizeWeeklyCalendarFormatFilters,
  WEEKLY_CALENDAR_FORMAT_OPTIONS,
  WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS,
  type WeeklyCalendarFormatFilter,
  type WeeklyCalendarMediaStatusFilter,
  type WeeklyCalendarScoreFilters,
} from './weeklyCalendarLogic';
import {
  isSeasonalStatusLetterShow,
  listStatusScoreLabel,
  normalizeSeasonalListScore,
  scoreDisplayToneClass,
} from './seasonalScoresLogic';

export type StatsMediaType = AnilistMediaType;

export type StatsAggregationType = 'VA' | 'STAFF' | 'GENRES_TAGS' | 'STUDIOS';

export type StatsCharacterRoleFilter = AnilistCharacterRole;

export const STATS_CHARACTER_ROLE_OPTIONS: StatsCharacterRoleFilter[] = [
  'MAIN',
  'SUPPORTING',
  'BACKGROUND',
];

export type StatsStaffRoleKey = string;

export const STATS_STAFF_OTHER_ROLE_KEY = 'OTHER';

export function statsAnimeStaffRoleOptions(): StatsStaffRoleKey[] {
  return [...KEY_ANIME_PRODUCTION_ROLES, STATS_STAFF_OTHER_ROLE_KEY];
}

export function statsMangaStaffRoleOptions(): StatsStaffRoleKey[] {
  return [...KEY_MANGA_PRODUCTION_ROLES, STATS_STAFF_OTHER_ROLE_KEY];
}

/** Default production-role filter: all key roles, excluding Other. */
export function statsDefaultStaffRoleFilters(mediaType: StatsMediaType): StatsStaffRoleKey[] {
  return mediaType === 'MANGA'
    ? [...KEY_MANGA_PRODUCTION_ROLES]
    : [...KEY_ANIME_PRODUCTION_ROLES];
}

export type StatsStudioKindFilter = 'animation' | 'non_animation';

export const STATS_STUDIO_KIND_OPTIONS: StatsStudioKindFilter[] = [
  'animation',
  'non_animation',
];

export type StatsMediaStatusFilter = WeeklyCalendarMediaStatusFilter;
export type StatsFormatFilter = WeeklyCalendarFormatFilter;

export const STATS_MEDIA_STATUS_OPTIONS = WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS;
export const STATS_ANIME_FORMAT_OPTIONS = WEEKLY_CALENDAR_FORMAT_OPTIONS;
export const STATS_MANGA_FORMAT_OPTIONS = ['MANGA', 'NOVEL', 'ONE_SHOT'] as const satisfies readonly AnilistMediaFormat[];

export type StatsMangaFormatFilter = (typeof STATS_MANGA_FORMAT_OPTIONS)[number];

export type StatsListStatus = (typeof ALL_LIST_STATUSES)[number];

export const STATS_LIST_STATUS_OPTIONS = ALL_LIST_STATUSES;

export const DEFAULT_STATS_MEDIA_STATUS_FILTERS: StatsMediaStatusFilter[] = [
  ...STATS_MEDIA_STATUS_OPTIONS,
];

export const DEFAULT_STATS_LIST_STATUS_FILTERS: StatsListStatus[] = [
  ...STATS_LIST_STATUS_OPTIONS,
];

export type StatsTagOptions = {
  tagMode: TagFilterMode;
  tagMinRank: number;
};

export const DEFAULT_STATS_TAG_OPTIONS: StatsTagOptions = {
  tagMode: 'or',
  tagMinRank: 0,
};

export type StatsStartDate = {
  year: number | null;
  month: number | null;
  day: number | null;
};

export type StatsForm = {
  username: string;
  mediaType: StatsMediaType;
  mediaStatusFilters: StatsMediaStatusFilter[];
  formatFilters: StatsFormatFilter[] | StatsMangaFormatFilter[];
  listStatusFilters: StatsListStatus[];
  userScoreInclude: WeeklyCalendarScoreFilters['userScoreInclude'];
  scoreMin: number | null;
  scoreMax: number | null;
  /** Minimum parent-row count after aggregation (0 = no filter). */
  minCount: number;
  showSummary: boolean;
  aggregationType: StatsAggregationType;
  staffRoleFilters: StatsStaffRoleKey[];
  vaRoleFilters: StatsCharacterRoleFilter[];
  vaShowMainRoleInfo: boolean;
  vaShowDiff: boolean;
  tagOptions: StatsTagOptions;
  studioKindFilters: StatsStudioKindFilter[];
};

export type StatsStaffCredit = {
  staffId: number;
  staffName: string;
  staffImage: string | null;
  staffGender: string | null;
  role: string;
};

export type StatsVaCredit = {
  staffId: number;
  staffName: string;
  staffImage: string | null;
  staffGender: string | null;
  characterId: number;
  characterName: string;
  characterRole: StatsCharacterRoleFilter;
};

export type StatsStudioLink = {
  studioId: number;
  studioName: string;
  isAnimation: boolean;
};

export type StatsMediaTag = {
  name: string;
  rank: number;
};

export type StatsEntry = {
  mediaId: number;
  title: string;
  titleSource: MediaTitleFields;
  coverImage: string | null;
  mediaType: StatsMediaType;
  format: AnilistMediaFormat | null;
  mediaStatus: AnilistMediaStatus | null;
  listStatus: string;
  score: number | null;
  repeat: number | null;
  notes: string | null;
  progress: number;
  progressVolumes: number | null;
  episodes: number | null;
  chapters: number | null;
  volumes: number | null;
  duration: number | null;
  meanScore: number | null;
  startDate: StatsStartDate;
  genres: string[];
  tags: StatsMediaTag[];
  studios: StatsStudioLink[];
  staffCredits: StatsStaffCredit[];
  vaCredits: StatsVaCredit[];
};

export type StatsVaSubrowCharacter = {
  characterId: number;
  characterName: string;
  characterRole: StatsCharacterRoleFilter;
};

export type StatsSubrowLink = {
  /** VA chart: all voiced characters on this show (one subrow per show). */
  characters?: readonly StatsVaSubrowCharacter[];
  characterId?: number;
  characterName?: string;
  characterRole?: string;
  staffRole?: string;
};

export type StatsSubrow = {
  entry: StatsEntry;
  link?: StatsSubrowLink;
};

export type StatsRowMetrics = {
  count: number;
  meanScore: number | null;
  anilistMeanScore: number | null;
  mainRoleCount: number | null;
  mainRoleMeanScore: number | null;
  mainRoleAnilistMeanScore: number | null;
  scoreDiff: number | null;
  episodesWatched: number;
  timeWatchedMinutes: number;
  episodesRemaining: number;
  timeRemainingMinutes: number;
  chaptersRead: number;
  chaptersRemaining: number;
  volumesRead: number;
  volumesRemaining: number;
};

export type StatsParentRow = {
  key: string;
  name: string;
  staffId?: number;
  staffImage?: string | null;
  staffGender?: string | null;
  studioId?: number;
  isNonAnimationStudio?: boolean;
  metrics: StatsRowMetrics;
  subrows: StatsSubrow[];
};

export type StatsSortColumn =
  | 'name'
  | 'count'
  | 'meanScore'
  | 'anilistMeanScore'
  | 'mainRoleCount'
  | 'mainRoleMeanScore'
  | 'mainRoleAnilistMeanScore'
  | 'scoreDiff'
  | 'episodesWatched'
  | 'timeWatched'
  | 'episodesRemaining'
  | 'timeRemaining'
  | 'chaptersRead'
  | 'chaptersRemaining'
  | 'volumesRead'
  | 'volumesRemaining';

export type StatsSortDirection = 'asc' | 'desc';

export type StatsSortState = {
  column: StatsSortColumn;
  direction: StatsSortDirection;
} | null;

/** Default parent-row sort: highest count first. */
export const DEFAULT_STATS_TABLE_SORT: StatsSortState = {
  column: 'count',
  direction: 'desc',
};

export type StatsTableChartId =
  | 'staff'
  | 'va'
  | 'genres'
  | 'tags'
  | 'customTags'
  | 'studios';

export type StatsTableSortConfig = {
  parent: StatsSortState;
  /** `null` = subrows sorted by release date (oldest first). */
  subrow: StatsSortState;
};

export const DEFAULT_STATS_CHART_SORT: StatsTableSortConfig = {
  parent: DEFAULT_STATS_TABLE_SORT,
  subrow: null,
};

export function createDefaultStatsChartSorts(): Record<StatsTableChartId, StatsTableSortConfig> {
  const blank = (): StatsTableSortConfig => ({
    parent: { ...DEFAULT_STATS_TABLE_SORT! },
    subrow: null,
  });
  return {
    staff: blank(),
    va: blank(),
    genres: blank(),
    tags: blank(),
    customTags: blank(),
    studios: blank(),
  };
}

export type StatsSummary = {
  onList: number;
  rated: number;
  meanScore: number | null;
  weightedMeanScore: number | null;
  medianScore: number | null;
  globalDifference: number | null;
  globalDeviation: number | null;
  ratingEntropy: number | null;
  mostCommonScore: number | null;
  mostCommonScoreCount: number;
  timeWatchedMinutes: number;
  episodesWatched: number;
  episodesRemaining: number;
  chaptersRead: number;
  chaptersRemaining: number;
  volumesRead: number;
};

export type StatsCachedData = {
  username: string;
  mediaType: StatsMediaType;
  entries: StatsEntry[];
  /** True after {@link expandStatsCast} has attached staff/VA credits to every entry. */
  castExpanded?: boolean;
  /** Shows with cast cache older than 90d (set after cast expansion). */
  staleCastMediaCount?: number;
};

export type StatsBuildResult = {
  pool: StatsEntry[];
  genreRows: StatsParentRow[];
  tagRows: StatsParentRow[];
  customTagRows: StatsParentRow[];
  staffRows: StatsParentRow[];
  vaRows: StatsParentRow[];
  studioRows: StatsParentRow[];
  summary: StatsSummary | null;
};

export function normalizeStatsMediaStatusFilters(raw: unknown): StatsMediaStatusFilter[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STATS_MEDIA_STATUS_FILTERS];
  }
  const selected = STATS_MEDIA_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_STATS_MEDIA_STATUS_FILTERS];
}

export function normalizeStatsListStatusFilters(raw: unknown): StatsListStatus[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STATS_LIST_STATUS_FILTERS];
  }
  const selected = STATS_LIST_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_STATS_LIST_STATUS_FILTERS];
}

export function normalizeStatsAnimeFormatFilters(raw: unknown): StatsFormatFilter[] {
  const selected = normalizeWeeklyCalendarFormatFilters(raw);
  return selected.length > 0 ? [...selected] : [...STATS_ANIME_FORMAT_OPTIONS];
}

export function normalizeStatsMangaFormatFilters(raw: unknown): StatsMangaFormatFilter[] {
  if (!Array.isArray(raw)) {
    return [...STATS_MANGA_FORMAT_OPTIONS];
  }
  const selected = STATS_MANGA_FORMAT_OPTIONS.filter((format) => raw.includes(format));
  return selected.length > 0 ? [...selected] : [...STATS_MANGA_FORMAT_OPTIONS];
}

export function normalizeStatsStaffRoleFilters(
  raw: unknown,
  mediaType: StatsMediaType,
): StatsStaffRoleKey[] {
  const universe =
    mediaType === 'MANGA' ? statsMangaStaffRoleOptions() : statsAnimeStaffRoleOptions();
  if (!Array.isArray(raw)) {
    return statsDefaultStaffRoleFilters(mediaType);
  }
  const selected = universe.filter((role) => raw.includes(role));
  return selected.length > 0 ? [...selected] : statsDefaultStaffRoleFilters(mediaType);
}

export function normalizeStatsVaRoleFilters(raw: unknown): StatsCharacterRoleFilter[] {
  if (!Array.isArray(raw)) {
    return [...STATS_CHARACTER_ROLE_OPTIONS];
  }
  const selected = STATS_CHARACTER_ROLE_OPTIONS.filter((role) => raw.includes(role));
  return selected.length > 0 ? [...selected] : [...STATS_CHARACTER_ROLE_OPTIONS];
}

export function normalizeStatsStudioKindFilters(raw: unknown): StatsStudioKindFilter[] {
  if (!Array.isArray(raw)) {
    return [...STATS_STUDIO_KIND_OPTIONS];
  }
  const selected = STATS_STUDIO_KIND_OPTIONS.filter((kind) => raw.includes(kind));
  return selected.length > 0 ? [...selected] : [...STATS_STUDIO_KIND_OPTIONS];
}

export function normalizeStatsTagOptions(raw: unknown): StatsTagOptions {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STATS_TAG_OPTIONS };
  }
  const obj = raw as Partial<StatsTagOptions>;
  const tagMode = obj.tagMode === 'and' ? 'and' : 'or';
  const tagMinRank =
    typeof obj.tagMinRank === 'number' && obj.tagMinRank >= 0 && obj.tagMinRank <= 100
      ? obj.tagMinRank
      : 0;
  return { tagMode, tagMinRank };
}

export function defaultStatsAggregationType(mediaType: StatsMediaType): StatsAggregationType {
  return mediaType === 'MANGA' ? 'GENRES_TAGS' : 'VA';
}

export function availableStatsAggregationTypes(mediaType: StatsMediaType): StatsAggregationType[] {
  if (mediaType === 'MANGA') {
    return ['STAFF', 'GENRES_TAGS'];
  }
  return ['VA', 'STAFF', 'GENRES_TAGS', 'STUDIOS'];
}

export function normalizeStatsAggregationType(
  raw: unknown,
  mediaType: StatsMediaType,
): StatsAggregationType {
  const allowed = availableStatsAggregationTypes(mediaType);
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    return raw as StatsAggregationType;
  }
  return defaultStatsAggregationType(mediaType);
}

export function formatStatsMediaStatusLabel(status: StatsMediaStatusFilter): string {
  return formatWeeklyCalendarMediaStatusFilterLabel(status);
}

export function formatStatsFormatLabel(format: StatsFormatFilter | StatsMangaFormatFilter): string {
  if (format === 'MANGA' || format === 'NOVEL' || format === 'ONE_SHOT') {
    switch (format) {
      case 'MANGA':
        return 'MANGA';
      case 'NOVEL':
        return 'LIGHT_NOVEL';
      case 'ONE_SHOT':
        return 'ONE_SHOT';
    }
  }
  return formatWeeklyCalendarFormatFilterLabel(format as WeeklyCalendarFormatFilter);
}

export function normalizeCharacterRoleForStats(
  role: string | null | undefined,
): StatsCharacterRoleFilter {
  if (role === 'MAIN' || role === 'SUPPORTING' || role === 'BACKGROUND') {
    return role;
  }
  return 'BACKGROUND';
}

/** Animation studio when AniList `isMain` is stored; legacy rows use sort_order 0. */
export function statsStudioIsAnimation(isMain: boolean | null, sortOrder: number): boolean {
  if (isMain != null) {
    return isMain;
  }
  return sortOrder === 0;
}

/** Actionable empty-table message for aggregation tables. */
export function statsAggregationEmptyHint(
  aggregationType: StatsAggregationType,
  castNeedsExpand: boolean,
): string {
  if (aggregationType === 'STAFF' || aggregationType === 'VA') {
    if (castNeedsExpand) {
      return 'Cast is not loaded yet. Click Expand all cast or Run with Staff/VA selected.';
    }
  }
  return 'No rows match the current filters.';
}

/** Parse `#token ` custom tags from list notes (space-terminated tokens). */
export function parseCustomTagsFromNotes(notes: string | null | undefined): string[] {
  if (!notes) {
    return [];
  }
  const tags: string[] = [];
  const re = /#(\S+?)(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(notes)) !== null) {
    const token = `#${match[1]}`;
    if (!token.startsWith('#039')) {
      tags.push(token);
    }
  }
  return tags;
}

function entryMatchesListStatus(
  entry: StatsEntry,
  filters: readonly StatsListStatus[],
): boolean {
  return filters.includes(entry.listStatus as StatsListStatus);
}

function entryMatchesMediaStatus(entry: StatsEntry, filters: readonly StatsMediaStatusFilter[]): boolean {
  if (!entry.mediaStatus) {
    return false;
  }
  return filters.includes(entry.mediaStatus as StatsMediaStatusFilter);
}

function entryMatchesFormat(
  entry: StatsEntry,
  filters: readonly (StatsFormatFilter | StatsMangaFormatFilter)[],
): boolean {
  if (!entry.format) {
    return false;
  }
  return (filters as readonly string[]).includes(entry.format);
}

function entryMatchesScore(entry: StatsEntry, form: Pick<StatsForm, 'userScoreInclude' | 'scoreMin' | 'scoreMax'>): boolean {
  return entryMatchesWeeklyScoreFilters(entry.score, {
    userScoreInclude: form.userScoreInclude,
    scoreMin: form.scoreMin,
    scoreMax: form.scoreMax,
  });
}

export function filterStatsPool(entries: readonly StatsEntry[], form: StatsForm): StatsEntry[] {
  return entries.filter(
    (entry) =>
      entry.mediaType === form.mediaType &&
      entryMatchesMediaStatus(entry, form.mediaStatusFilters) &&
      entryMatchesFormat(entry, form.formatFilters) &&
      entryMatchesListStatus(entry, form.listStatusFilters) &&
      entryMatchesScore(entry, form),
  );
}

export function filterStatsParentRowsByMinCount(
  rows: readonly StatsParentRow[],
  minCount: number,
): StatsParentRow[] {
  if (minCount <= 0) {
    return [...rows];
  }
  return rows.filter((row) => row.metrics.count >= minCount);
}

export function statsEffectiveEpisodes(entry: StatsEntry): number {
  const progress = entry.progress ?? 0;
  const total = entry.episodes ?? progress;
  const repeat = entry.repeat ?? 0;
  const epCount = Math.max(progress, total);
  let episodes = progress;
  episodes += repeat * epCount;
  return episodes;
}

function entryTimeWatchedMinutes(entry: StatsEntry): number {
  if (entry.mediaType !== 'ANIME') {
    return 0;
  }
  const duration = entry.duration ?? 1;
  const progress = entry.progress ?? 0;
  const total = entry.episodes ?? progress;
  const repeat = entry.repeat ?? 0;
  const epCount = Math.max(progress, total);
  let minutes = progress * duration;
  minutes += repeat * epCount * duration;
  return minutes;
}

export function entryEpisodesRemaining(entry: StatsEntry): number {
  if (entry.mediaType !== 'ANIME') {
    return 0;
  }
  if (entry.listStatus === 'COMPLETED') {
    return 0;
  }
  const total = entry.episodes;
  if (total == null || total <= 0) {
    return 0;
  }
  const progress = entry.progress ?? 0;
  return Math.max(0, total - progress);
}

export function entryTimeRemainingMinutes(entry: StatsEntry): number {
  if (entry.mediaType !== 'ANIME') {
    return 0;
  }
  const duration = entry.duration ?? 1;
  return entryEpisodesRemaining(entry) * duration;
}

export function entryChaptersRemaining(entry: StatsEntry): number {
  if (entry.mediaType !== 'MANGA') {
    return 0;
  }
  if (entry.listStatus === 'COMPLETED') {
    return 0;
  }
  const total = entry.chapters;
  if (total == null || total <= 0) {
    return 0;
  }
  const progress = entry.progress ?? 0;
  return Math.max(0, total - progress);
}

export function entryVolumesRemaining(entry: StatsEntry): number {
  const total = entry.volumes ?? 0;
  const progress = entry.progressVolumes ?? 0;
  return Math.max(0, total - progress);
}

function isRatedForMean(entry: StatsEntry): boolean {
  return !isSeasonalStatusLetterShow({
    listStatus: entry.listStatus,
    score: entry.score,
  });
}

function ratedScore(entry: StatsEntry): number | null {
  if (!isRatedForMean(entry)) {
    return null;
  }
  return normalizeSeasonalListScore(entry.score);
}

function averageNullable(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function computeMetricsForEntries(
  entries: readonly StatsEntry[],
  options: {
    mediaType: StatsMediaType;
    vaShowDiff?: boolean;
    mainRoleMediaIds?: ReadonlySet<number>;
  },
): StatsRowMetrics {
  const ratedScores = entries.map((e) => ratedScore(e)).filter((s): s is number => s != null);
  const anilistScores = entries
    .map((e) => e.meanScore)
    .filter((s): s is number => s != null && s > 0);

  let mainRoleCount: number | null = null;
  let mainRoleMeanScore: number | null = null;
  let mainRoleAnilistMean: number | null = null;
  if (options.mainRoleMediaIds != null) {
    const mainEntries = entries.filter((e) => options.mainRoleMediaIds!.has(e.mediaId));
    mainRoleCount = mainEntries.length;
    const mainRated = mainEntries.map((e) => ratedScore(e)).filter((s): s is number => s != null);
    mainRoleMeanScore = averageNullable(mainRated);
    const mainAnilist = mainEntries
      .map((e) => e.meanScore)
      .filter((s): s is number => s != null && s > 0);
    mainRoleAnilistMean = averageNullable(mainAnilist);
  }

  const meanScore = averageNullable(ratedScores);
  const anilistMeanScore = averageNullable(anilistScores);
  let scoreDiff: number | null = null;
  if (options.vaShowDiff && meanScore != null && anilistMeanScore != null) {
    scoreDiff = meanScore - anilistMeanScore;
  }

  let episodesWatched = 0;
  let timeWatchedMinutes = 0;
  let episodesRemaining = 0;
  let timeRemainingMinutes = 0;
  let chaptersRead = 0;
  let chaptersRemaining = 0;
  let volumesRead = 0;
  let volumesRemaining = 0;

  for (const entry of entries) {
    if (entry.mediaType === 'ANIME') {
      episodesWatched += statsEffectiveEpisodes(entry);
      timeWatchedMinutes += entryTimeWatchedMinutes(entry);
      episodesRemaining += entryEpisodesRemaining(entry);
      timeRemainingMinutes += entryTimeRemainingMinutes(entry);
    } else {
      chaptersRead += entry.progress ?? 0;
      chaptersRemaining += entryChaptersRemaining(entry);
      volumesRead += entry.progressVolumes ?? 0;
      volumesRemaining += entryVolumesRemaining(entry);
    }
  }

  return {
    count: entries.length,
    meanScore,
    anilistMeanScore,
    mainRoleCount,
    mainRoleMeanScore,
    mainRoleAnilistMeanScore: mainRoleAnilistMean,
    scoreDiff,
    episodesWatched,
    timeWatchedMinutes,
    episodesRemaining,
    timeRemainingMinutes,
    chaptersRead,
    chaptersRemaining,
    volumesRead,
    volumesRemaining,
  };
}

function staffRoleMatchesFilter(
  role: string,
  filters: readonly StatsStaffRoleKey[],
  mediaType: StatsMediaType,
): boolean {
  const normalized = normalizeProductionRoleForMatch(role);
  const isKey = isKeyProductionRole(role, mediaType);
  if (isKey) {
    return filters.includes(normalized);
  }
  return filters.includes(STATS_STAFF_OTHER_ROLE_KEY);
}

function vaRoleMatchesFilter(role: StatsCharacterRoleFilter, filters: readonly StatsCharacterRoleFilter[]): boolean {
  return filters.includes(role);
}

function studioMatchesKind(studio: StatsStudioLink, filters: readonly StatsStudioKindFilter[]): boolean {
  const kind: StatsStudioKindFilter = studio.isAnimation ? 'animation' : 'non_animation';
  return filters.includes(kind);
}

function tagPassesMinRank(tag: StatsMediaTag, minRank: number): boolean {
  return minRank <= 0 || tag.rank >= minRank;
}

function buildParentRow(
  key: string,
  name: string,
  entries: StatsEntry[],
  subrows: StatsSubrow[],
  extra: Partial<StatsParentRow> = {},
  metricOptions: {
    mediaType: StatsMediaType;
    vaShowDiff?: boolean;
    mainRoleMediaIds?: ReadonlySet<number>;
  },
): StatsParentRow {
  return {
    key,
    name,
    metrics: computeMetricsForEntries(entries, metricOptions),
    subrows,
    ...extra,
  };
}

export function buildStaffStatsRows(
  pool: readonly StatsEntry[],
  form: StatsForm,
): StatsParentRow[] {
  const byStaff = new Map<number, { name: string; image: string | null; gender: string | null; entries: StatsEntry[]; subrows: StatsSubrow[] }>();

  for (const entry of pool) {
    const matchedCredits = entry.staffCredits.filter((credit) =>
      staffRoleMatchesFilter(credit.role, form.staffRoleFilters, form.mediaType),
    );
    if (matchedCredits.length === 0) {
      continue;
    }
    const seenStaff = new Set<number>();
    for (const credit of matchedCredits) {
      if (seenStaff.has(credit.staffId)) {
        continue;
      }
      seenStaff.add(credit.staffId);
      let bucket = byStaff.get(credit.staffId);
      if (!bucket) {
        bucket = {
          name: credit.staffName,
          image: credit.staffImage,
          gender: credit.staffGender,
          entries: [],
          subrows: [],
        };
        byStaff.set(credit.staffId, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({
          entry,
          link: { staffRole: credit.role },
        });
      }
    }
  }

  return [...byStaff.entries()].map(([staffId, bucket]) =>
    buildParentRow(
      `staff:${staffId}`,
      bucket.name,
      bucket.entries,
      bucket.subrows,
      {
        staffId,
        staffImage: bucket.image,
        staffGender: bucket.gender,
      },
      {
        mediaType: form.mediaType,
      },
    ),
  );
}

export function buildVaStatsRows(pool: readonly StatsEntry[], form: StatsForm): StatsParentRow[] {
  const byVa = new Map<
    number,
    {
      name: string;
      image: string | null;
      gender: string | null;
      entries: StatsEntry[];
      subrows: StatsSubrow[];
      mainRoleMediaIds: Set<number>;
    }
  >();

  for (const entry of pool) {
    const matchedCredits = entry.vaCredits.filter((credit) =>
      vaRoleMatchesFilter(credit.characterRole, form.vaRoleFilters),
    );
    if (matchedCredits.length === 0) {
      continue;
    }

    const creditsByVa = new Map<number, StatsVaCredit[]>();
    for (const credit of matchedCredits) {
      const list = creditsByVa.get(credit.staffId);
      if (list) {
        list.push(credit);
      } else {
        creditsByVa.set(credit.staffId, [credit]);
      }
    }

    for (const [staffId, credits] of creditsByVa) {
      let bucket = byVa.get(staffId);
      if (!bucket) {
        const first = credits[0];
        bucket = {
          name: first.staffName,
          image: first.staffImage,
          gender: first.staffGender,
          entries: [],
          subrows: [],
          mainRoleMediaIds: new Set(),
        };
        byVa.set(staffId, bucket);
      }

      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
      }

      let subrow = bucket.subrows.find((s) => s.entry.mediaId === entry.mediaId);
      if (!subrow) {
        subrow = {
          entry,
          link: { characters: [] },
        };
        bucket.subrows.push(subrow);
      }

      const mergedCharacters: StatsVaSubrowCharacter[] = [...(subrow.link?.characters ?? [])];
      const seenCharacterIds = new Set(mergedCharacters.map((character) => character.characterId));
      for (const credit of credits) {
        if (seenCharacterIds.has(credit.characterId)) {
          continue;
        }
        seenCharacterIds.add(credit.characterId);
        mergedCharacters.push({
          characterId: credit.characterId,
          characterName: credit.characterName,
          characterRole: credit.characterRole,
        });
        if (credit.characterRole === 'MAIN') {
          bucket.mainRoleMediaIds.add(entry.mediaId);
        }
      }
      if (subrow.link) {
        subrow.link.characters = mergedCharacters;
      }
    }
  }

  return [...byVa.entries()].map(([staffId, bucket]) =>
    buildParentRow(
      `va:${staffId}`,
      bucket.name,
      bucket.entries,
      bucket.subrows,
      {
        staffId,
        staffImage: bucket.image,
        staffGender: bucket.gender,
      },
      {
        mediaType: form.mediaType,
        vaShowDiff: form.vaShowDiff,
        mainRoleMediaIds: bucket.mainRoleMediaIds,
      },
    ),
  );
}

export function buildGenreStatsRows(pool: readonly StatsEntry[]): StatsParentRow[] {
  const byGenre = new Map<string, { entries: StatsEntry[]; subrows: StatsSubrow[] }>();
  for (const entry of pool) {
    for (const genre of entry.genres) {
      let bucket = byGenre.get(genre);
      if (!bucket) {
        bucket = { entries: [], subrows: [] };
        byGenre.set(genre, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({ entry });
      }
    }
  }
  return [...byGenre.entries()].map(([genre, bucket]) =>
    buildParentRow(`genre:${genre}`, genre, bucket.entries, bucket.subrows, {}, { mediaType: pool[0]?.mediaType ?? 'ANIME' }),
  );
}

export function buildAnilistTagStatsRows(pool: readonly StatsEntry[], form: StatsForm): StatsParentRow[] {
  const byTag = new Map<string, { entries: StatsEntry[]; subrows: StatsSubrow[] }>();
  for (const entry of pool) {
    for (const tag of entry.tags) {
      if (!tagPassesMinRank(tag, form.tagOptions.tagMinRank)) {
        continue;
      }
      let bucket = byTag.get(tag.name);
      if (!bucket) {
        bucket = { entries: [], subrows: [] };
        byTag.set(tag.name, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({ entry });
      }
    }
  }
  return [...byTag.entries()].map(([tagName, bucket]) =>
    buildParentRow(`tag:${tagName}`, tagName, bucket.entries, bucket.subrows, {}, { mediaType: form.mediaType }),
  );
}

export function buildCustomTagStatsRows(pool: readonly StatsEntry[]): StatsParentRow[] {
  const byTag = new Map<string, { entries: StatsEntry[]; subrows: StatsSubrow[] }>();
  for (const entry of pool) {
    const tags = parseCustomTagsFromNotes(entry.notes);
    for (const tag of tags) {
      let bucket = byTag.get(tag);
      if (!bucket) {
        bucket = { entries: [], subrows: [] };
        byTag.set(tag, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({ entry });
      }
    }
  }
  return [...byTag.entries()].map(([tagName, bucket]) =>
    buildParentRow(`custom:${tagName}`, tagName, bucket.entries, bucket.subrows, {}, { mediaType: pool[0]?.mediaType ?? 'ANIME' }),
  );
}

export function buildStudioStatsRows(pool: readonly StatsEntry[], form: StatsForm): StatsParentRow[] {
  const byStudio = new Map<
    number,
    {
      name: string;
      isAnimation: boolean;
      entries: StatsEntry[];
      subrows: StatsSubrow[];
    }
  >();
  for (const entry of pool) {
    for (const studio of entry.studios) {
      if (!studioMatchesKind(studio, form.studioKindFilters)) {
        continue;
      }
      let bucket = byStudio.get(studio.studioId);
      if (!bucket) {
        bucket = {
          name: studio.studioName,
          isAnimation: studio.isAnimation,
          entries: [],
          subrows: [],
        };
        byStudio.set(studio.studioId, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({ entry });
      }
    }
  }
  return [...byStudio.entries()].map(([studioId, bucket]) =>
    buildParentRow(
      `studio:${studioId}`,
      bucket.name,
      bucket.entries,
      bucket.subrows,
      {
        studioId,
        isNonAnimationStudio: !bucket.isAnimation,
      },
      { mediaType: form.mediaType },
    ),
  );
}

export function buildStatsSummary(pool: readonly StatsEntry[]): StatsSummary {
  const ratedEntries = pool.filter((e) => ratedScore(e) != null);
  const ratedScores = ratedEntries.map((e) => ratedScore(e)!).sort((a, b) => a - b);
  const histogram = new Array<number>(100).fill(0);
  let sumWeight = 0;
  let sumEntriesWeight = 0;
  for (const entry of ratedEntries) {
    const score = ratedScore(entry)!;
    histogram[score - 1] += 1;
    const weight =
      entry.mediaType === 'ANIME'
        ? (entry.duration ?? 1) * (entry.episodes ?? 0)
        : entry.chapters ?? 0;
    sumWeight += weight;
    sumEntriesWeight += score * weight;
  }

  let mostCommonScore: number | null = null;
  let mostCommonScoreCount = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    const count = histogram[i];
    if (count > mostCommonScoreCount) {
      mostCommonScoreCount = count;
      mostCommonScore = i + 1;
    }
  }

  const meanScore = averageNullable(ratedScores);
  const medianScore =
    ratedScores.length === 0
      ? null
      : ratedScores.length % 2 === 1
        ? ratedScores[Math.floor(ratedScores.length / 2)]
        : (ratedScores[ratedScores.length / 2 - 1] + ratedScores[ratedScores.length / 2]) / 2;

  let globalDifference: number | null = null;
  let globalDeviation: number | null = null;
  if (ratedEntries.length > 0) {
    const diffs: number[] = [];
    const sqDiffs: number[] = [];
    for (const entry of ratedEntries) {
      const score = ratedScore(entry)!;
      const mean = entry.meanScore;
      if (mean != null && mean > 0) {
        diffs.push(score - mean);
        sqDiffs.push((score - mean) ** 2);
      }
    }
    globalDifference = averageNullable(diffs);
    globalDeviation =
      sqDiffs.length > 0
        ? Math.sqrt(sqDiffs.reduce((s, v) => s + v, 0) / sqDiffs.length)
        : null;
  }

  let ratingEntropy: number | null = null;
  if (ratedScores.length > 0) {
    const amount = ratedScores.length;
    ratingEntropy = -histogram.reduce((acc, val) => {
      if (val > 0) {
        const p = val / amount;
        return acc + Math.log2(p) * p;
      }
      return acc;
    }, 0);
  }

  let timeWatchedMinutes = 0;
  let episodesWatched = 0;
  let episodesRemaining = 0;
  let chaptersRead = 0;
  let chaptersRemaining = 0;
  let volumesRead = 0;
  for (const entry of pool) {
    if (entry.mediaType === 'ANIME') {
      timeWatchedMinutes += entryTimeWatchedMinutes(entry);
      episodesWatched += statsEffectiveEpisodes(entry);
      episodesRemaining += entryEpisodesRemaining(entry);
    } else {
      chaptersRead += entry.progress ?? 0;
      chaptersRemaining += entryChaptersRemaining(entry);
      volumesRead += entry.progressVolumes ?? 0;
    }
  }

  return {
    onList: pool.length,
    rated: ratedScores.length,
    meanScore,
    weightedMeanScore: sumWeight > 0 ? sumEntriesWeight / sumWeight : null,
    medianScore,
    globalDifference,
    globalDeviation,
    ratingEntropy,
    mostCommonScore: mostCommonScoreCount > 0 ? mostCommonScore : null,
    mostCommonScoreCount,
    timeWatchedMinutes,
    episodesWatched,
    episodesRemaining,
    chaptersRead,
    chaptersRemaining,
    volumesRead,
  };
}

export function statsRatedScore(entry: StatsEntry): number | null {
  return ratedScore(entry);
}

const STATS_STATUS_LETTER_SORT_RANK: Record<'P' | 'W' | 'R' | 'H', number> = {
  P: -40,
  W: -30,
  R: -20,
  H: -10,
};

/** Numeric sort key for score column: rated scores 1–10, status letters below, unrated last. */
export function statsEntryScoreSortValue(entry: StatsEntry): number | null {
  const label = listStatusScoreLabel(entry.listStatus, entry.score, entry.mediaType);
  if (label != null) {
    return STATS_STATUS_LETTER_SORT_RANK[label];
  }
  return normalizeSeasonalListScore(entry.score);
}

export function statsEntryStartDateSortKey(date: StatsStartDate): number {
  if (date.year == null) {
    return Number.MAX_SAFE_INTEGER;
  }
  const month = date.month ?? 1;
  const day = date.day ?? 1;
  return date.year * 10000 + month * 100 + day;
}

export function compareStatsSortValues(
  a: number | string | null,
  b: number | string | null,
  direction: StatsSortDirection = 'asc',
): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  let cmp = 0;
  if (typeof a === 'string' && typeof b === 'string') {
    cmp = a.localeCompare(b);
  } else {
    cmp = (a as number) - (b as number);
  }
  return direction === 'asc' ? cmp : -cmp;
}

function stableSort<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  const indexed = items.map((item, index) => ({ item, index }));
  indexed.sort((left, right) => {
    const cmp = compare(left.item, right.item);
    return cmp !== 0 ? cmp : left.index - right.index;
  });
  return indexed.map((row) => row.item);
}

function effectiveParentSort(sort: StatsSortState): {
  column: StatsSortColumn;
  direction: StatsSortDirection;
} {
  return sort ?? DEFAULT_STATS_TABLE_SORT!;
}

function sortMetricValue(row: StatsParentRow, column: StatsSortColumn): number | string | null {
  const m = row.metrics;
  switch (column) {
    case 'name':
      return row.name.toLowerCase();
    case 'count':
      return m.count;
    case 'meanScore':
      return m.meanScore;
    case 'anilistMeanScore':
      return m.anilistMeanScore;
    case 'mainRoleCount':
      return m.mainRoleCount;
    case 'mainRoleMeanScore':
      return m.mainRoleMeanScore;
    case 'mainRoleAnilistMeanScore':
      return m.mainRoleAnilistMeanScore;
    case 'scoreDiff':
      return m.scoreDiff;
    case 'episodesWatched':
      return m.episodesWatched;
    case 'timeWatched':
      return m.timeWatchedMinutes;
    case 'episodesRemaining':
      return m.episodesRemaining;
    case 'timeRemaining':
      return m.timeRemainingMinutes;
    case 'chaptersRead':
      return m.chaptersRead;
    case 'chaptersRemaining':
      return m.chaptersRemaining;
    case 'volumesRead':
      return m.volumesRead;
    case 'volumesRemaining':
      return m.volumesRemaining;
    default:
      return null;
  }
}

type StatsSubrowSortOptions = {
  mediaType: StatsMediaType;
  vaShowDiff?: boolean;
};

export function statsSubrowHasMainRole(link: StatsSubrowLink | undefined): boolean {
  if (link?.characters && link.characters.length > 0) {
    return link.characters.some((character) => character.characterRole === 'MAIN');
  }
  return link?.characterRole === 'MAIN';
}

function subrowIsMainRole(sub: StatsSubrow): boolean {
  return statsSubrowHasMainRole(sub.link);
}

function subrowScoreDiff(entry: StatsEntry, vaShowDiff: boolean): number | null {
  if (!vaShowDiff) {
    return null;
  }
  const rated = ratedScore(entry);
  const anilist = entry.meanScore;
  if (rated == null || anilist == null || anilist <= 0) {
    return null;
  }
  return rated - anilist;
}

function sortSubrowMetricValue(
  sub: StatsSubrow,
  column: StatsSortColumn,
  options: StatsSubrowSortOptions,
): number | string | null {
  const entry = sub.entry;
  const isMain = subrowIsMainRole(sub);
  switch (column) {
    case 'name':
      return entry.title.toLowerCase();
    case 'count':
      return 1;
    case 'meanScore':
      return statsEntryScoreSortValue(entry);
    case 'anilistMeanScore':
      return entry.meanScore;
    case 'mainRoleCount':
      return isMain ? 1 : null;
    case 'mainRoleMeanScore':
      return isMain ? ratedScore(entry) : null;
    case 'mainRoleAnilistMeanScore':
      return isMain ? entry.meanScore : null;
    case 'scoreDiff':
      return subrowScoreDiff(entry, options.vaShowDiff ?? false);
    case 'episodesWatched':
      return entry.mediaType === 'ANIME' ? statsEffectiveEpisodes(entry) : entry.progress ?? 0;
    case 'timeWatched':
      return entry.mediaType === 'ANIME' ? entryTimeWatchedMinutes(entry) : null;
    case 'episodesRemaining':
      return entry.mediaType === 'ANIME' ? entryEpisodesRemaining(entry) : null;
    case 'timeRemaining':
      return entry.mediaType === 'ANIME' ? entryTimeRemainingMinutes(entry) : null;
    case 'chaptersRead':
      return entry.mediaType === 'MANGA' ? entry.progress ?? 0 : null;
    case 'chaptersRemaining':
      return entry.mediaType === 'MANGA' ? entryChaptersRemaining(entry) : null;
    case 'volumesRead':
      return entry.mediaType === 'MANGA' ? entry.progressVolumes ?? 0 : null;
    case 'volumesRemaining':
      return entry.mediaType === 'MANGA' ? entryVolumesRemaining(entry) : null;
    default:
      return null;
  }
}

function sortSubrowsByReleaseDate(subrows: readonly StatsSubrow[]): StatsSubrow[] {
  return stableSort(subrows, (a, b) =>
    compareStatsSortValues(
      statsEntryStartDateSortKey(a.entry.startDate),
      statsEntryStartDateSortKey(b.entry.startDate),
      'asc',
    ),
  );
}

export function sortStatsSubrows(
  subrows: readonly StatsSubrow[],
  sort: StatsSortState,
  options: StatsSubrowSortOptions,
): StatsSubrow[] {
  if (!sort) {
    return sortSubrowsByReleaseDate(subrows);
  }
  return stableSort(subrows, (a, b) =>
    compareStatsSortValues(
      sortSubrowMetricValue(a, sort.column, options),
      sortSubrowMetricValue(b, sort.column, options),
      sort.direction,
    ),
  );
}

export function sortStatsParentRows(
  rows: readonly StatsParentRow[],
  parentSort: StatsSortState,
): StatsParentRow[] {
  const sort = effectiveParentSort(parentSort);
  return stableSort(rows, (a, b) =>
    compareStatsSortValues(sortMetricValue(a, sort.column), sortMetricValue(b, sort.column), sort.direction),
  );
}

export function applyStatsTableSort(
  rows: readonly StatsParentRow[],
  config: StatsTableSortConfig,
  options: StatsSubrowSortOptions,
): StatsParentRow[] {
  const sortedParents = sortStatsParentRows(rows, config.parent);
  return sortedParents.map((row) => ({
    ...row,
    subrows: sortStatsSubrows(row.subrows, config.subrow, options),
  }));
}

/** Left-click parent header: toggle asc/desc on the active column. */
export function cycleStatsParentSort(
  current: StatsSortState,
  column: StatsSortColumn,
): StatsSortState {
  const sort = effectiveParentSort(current);
  if (sort.column !== column) {
    return { column, direction: 'desc' };
  }
  return { column, direction: sort.direction === 'desc' ? 'asc' : 'desc' };
}

/** Right-click header: cycle subrow sort desc → asc → release-date default. */
export function cycleStatsSubrowSort(
  current: StatsSortState,
  column: StatsSortColumn,
): StatsSortState {
  if (!current || current.column !== column) {
    return { column, direction: 'desc' };
  }
  if (current.direction === 'desc') {
    return { column, direction: 'asc' };
  }
  return null;
}

export function buildStatsScoreHistogram(pool: readonly StatsEntry[]): number[] {
  const histogram = new Array<number>(100).fill(0);
  for (const entry of pool) {
    const score = ratedScore(entry);
    if (score != null) {
      histogram[score - 1] += 1;
    }
  }
  return histogram;
}

export function filterStatsPoolByRatingScore(
  pool: readonly StatsEntry[],
  score: number,
): StatsEntry[] {
  return pool.filter((entry) => ratedScore(entry) === score);
}

export type StatsTimeWatchedRow = {
  entry: StatsEntry;
  minutes: number;
};

export function buildStatsTimeWatchedRows(pool: readonly StatsEntry[]): StatsTimeWatchedRow[] {
  const rows: StatsTimeWatchedRow[] = [];
  for (const entry of pool) {
    if (entry.mediaType !== 'ANIME') {
      continue;
    }
    const minutes = entryTimeWatchedMinutes(entry);
    if (minutes <= 0) {
      continue;
    }
    rows.push({ entry, minutes });
  }
  return rows.sort((a, b) => b.minutes - a.minutes);
}

export function statsEntryTimeWatchedMinutes(entry: StatsEntry): number {
  return entryTimeWatchedMinutes(entry);
}

export function buildStatsResult(entries: readonly StatsEntry[], form: StatsForm): StatsBuildResult {
  const pool = filterStatsPool(entries, form);
  const genreRows = buildGenreStatsRows(pool);
  const tagRows = buildAnilistTagStatsRows(pool, form);
  const customTagRows = buildCustomTagStatsRows(pool);
  const staffRows = buildStaffStatsRows(pool, form);
  const vaRows = buildVaStatsRows(pool, form);
  const studioRows = buildStudioStatsRows(pool, form);
  const summary = form.showSummary ? buildStatsSummary(pool) : null;
  return {
    pool,
    genreRows,
    tagRows,
    customTagRows,
    staffRows,
    vaRows,
    studioRows,
    summary,
  };
}

export function formatStatsDuration(minutes: number): string {
  if (minutes <= 0) {
    return '0m';
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

export function formatStatsDurationWithDayCount(minutes: number): string {
  const duration = formatStatsDuration(minutes);
  const dayCount = Math.floor(minutes / (60 * 24) * 100) / 100; // round to 2 decimal places
  if (dayCount < 1) {
    return duration;
  }
  return `${duration} (${dayCount} days)`;
}

export function formatStatsScoreCell(entry: StatsEntry): string {
  const statusLabel = listStatusScoreLabel(entry.listStatus, entry.score, entry.mediaType);
  if (statusLabel != null) {
    return statusLabel;
  }
  const normalized = normalizeSeasonalListScore(entry.score);
  return normalized == null ? '—' : String(normalized);
}

export function statsScoreToneClass(entry: StatsEntry): string {
  const label = listStatusScoreLabel(entry.listStatus, entry.score, entry.mediaType);
  if (label != null) {
    return '';
  }
  return scoreDisplayToneClass(entry.score);
}

export function csvEscapeStatsCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildStatsTableCsv(
  rows: readonly StatsParentRow[],
  columns: readonly string[],
  rowToCells: (row: StatsParentRow) => string[],
): string {
  const header = columns.map(csvEscapeStatsCell).join(',');
  const body = rows.map((row) => rowToCells(row).map(csvEscapeStatsCell).join(','));
  return [header, ...body].join('\r\n');
}

export function buildStatsTableJson(rows: readonly StatsParentRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      name: row.name,
      ...row.metrics,
      subrows: row.subrows.map((sub) => ({
        mediaId: sub.entry.mediaId,
        title: sub.entry.title,
        score: formatStatsScoreCell(sub.entry),
      })),
    })),
    null,
    2,
  );
}
