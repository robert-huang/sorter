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
  normalizeWeeklyCalendarMediaStatusFilters,
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
  'RELEASING',
  'FINISHED',
];

export const DEFAULT_STATS_LIST_STATUS_FILTERS: StatsListStatus[] = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PAUSED',
  'DROPPED',
];

export type StatsTagOptions = {
  tagMode: TagFilterMode;
  tagMinRank: number;
};

export const DEFAULT_STATS_TAG_OPTIONS: StatsTagOptions = {
  tagMode: 'or',
  tagMinRank: 0,
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
  showSummary: boolean;
  aggregationType: StatsAggregationType;
  staffRoleFilters: StatsStaffRoleKey[];
  vaRoleFilters: StatsCharacterRoleFilter[];
  vaMainOnly: boolean;
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
  genres: string[];
  tags: StatsMediaTag[];
  studios: StatsStudioLink[];
  staffCredits: StatsStaffCredit[];
  vaCredits: StatsVaCredit[];
};

export type StatsSubrowLink = {
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
  chaptersRead: number;
  volumesRead: number;
};

export type StatsCachedData = {
  username: string;
  mediaType: StatsMediaType;
  entries: StatsEntry[];
  /** True after {@link expandStatsCast} has attached staff/VA credits to every entry. */
  castExpanded?: boolean;
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
  const selected = normalizeWeeklyCalendarMediaStatusFilters(raw);
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
    return [...universe];
  }
  const selected = universe.filter((role) => raw.includes(role));
  return selected.length > 0 ? [...selected] : [...universe];
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
        return 'Manga';
      case 'NOVEL':
        return 'Novel';
      case 'ONE_SHOT':
        return 'One Shot';
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
  aggregationType: StatsAggregationType,
): boolean {
  if (entry.listStatus === 'PLANNING') {
    if (aggregationType === 'STAFF' || aggregationType === 'VA') {
      return false;
    }
    return filters.includes('PLANNING');
  }
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
      entryMatchesListStatus(entry, form.listStatusFilters, form.aggregationType) &&
      entryMatchesScore(entry, form),
  );
}

function effectiveEpisodes(entry: StatsEntry): number {
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

function entryEpisodesRemaining(entry: StatsEntry): number {
  if (entry.mediaType !== 'ANIME') {
    return 0;
  }
  const total = entry.episodes ?? 0;
  const progress = entry.progress ?? 0;
  return Math.max(0, total - progress);
}

function entryTimeRemainingMinutes(entry: StatsEntry): number {
  if (entry.mediaType !== 'ANIME') {
    return 0;
  }
  const duration = entry.duration ?? 1;
  return entryEpisodesRemaining(entry) * duration;
}

function entryChaptersRemaining(entry: StatsEntry): number {
  const total = entry.chapters ?? 0;
  const progress = entry.progress ?? 0;
  return Math.max(0, total - progress);
}

function entryVolumesRemaining(entry: StatsEntry): number {
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
    vaMainOnly?: boolean;
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
  if (options.vaMainOnly) {
    const mainEntries =
      options.mainRoleMediaIds != null
        ? entries.filter((e) => options.mainRoleMediaIds!.has(e.mediaId))
        : entries;
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
      episodesWatched += effectiveEpisodes(entry);
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
    vaMainOnly?: boolean;
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
    const seenVa = new Set<number>();
    for (const credit of matchedCredits) {
      if (seenVa.has(credit.staffId)) {
        continue;
      }
      seenVa.add(credit.staffId);
      let bucket = byVa.get(credit.staffId);
      if (!bucket) {
        bucket = {
          name: credit.staffName,
          image: credit.staffImage,
          gender: credit.staffGender,
          entries: [],
          subrows: [],
          mainRoleMediaIds: new Set(),
        };
        byVa.set(credit.staffId, bucket);
      }
      if (!bucket.entries.some((e) => e.mediaId === entry.mediaId)) {
        bucket.entries.push(entry);
        bucket.subrows.push({
          entry,
          link: {
            characterId: credit.characterId,
            characterName: credit.characterName,
            characterRole: credit.characterRole,
          },
        });
      }
      if (credit.characterRole === 'MAIN') {
        bucket.mainRoleMediaIds.add(entry.mediaId);
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
        vaMainOnly: form.vaMainOnly,
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
  let chaptersRead = 0;
  let volumesRead = 0;
  for (const entry of pool) {
    if (entry.mediaType === 'ANIME') {
      timeWatchedMinutes += entryTimeWatchedMinutes(entry);
      episodesWatched += effectiveEpisodes(entry);
    } else {
      chaptersRead += entry.progress ?? 0;
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
    chaptersRead,
    volumesRead,
  };
}

export function statsRatedScore(entry: StatsEntry): number | null {
  return ratedScore(entry);
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

function compareSortValues(a: number | string | null, b: number | string | null): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b);
  }
  return (a as number) - (b as number);
}

export function sortStatsRows(
  rows: readonly StatsParentRow[],
  sort: StatsSortState,
): StatsParentRow[] {
  if (!sort) {
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }
  const sorted = [...rows].sort((a, b) => {
    const cmp = compareSortValues(sortMetricValue(a, sort.column), sortMetricValue(b, sort.column));
    return sort.direction === 'asc' ? cmp : -cmp;
  });
  return sorted.map((row) => ({
    ...row,
    subrows: [...row.subrows].sort((a, b) => {
      const cmp = compareSortValues(
        sortMetricValue(
          { ...row, metrics: computeMetricsForEntries([a.entry], { mediaType: a.entry.mediaType }) },
          sort.column,
        ),
        sortMetricValue(
          { ...row, metrics: computeMetricsForEntries([b.entry], { mediaType: b.entry.mediaType }) },
          sort.column,
        ),
      );
      return sort.direction === 'asc' ? cmp : -cmp;
    }),
  }));
}

export function cycleStatsSort(
  current: StatsSortState,
  column: StatsSortColumn,
  backward = false,
): StatsSortState {
  if (!current || current.column !== column) {
    return backward ? { column, direction: 'asc' } : { column, direction: 'desc' };
  }
  if (backward) {
    if (current.direction === 'desc') {
      return null;
    }
    if (current.direction === 'asc') {
      return { column, direction: 'desc' };
    }
    return { column, direction: 'asc' };
  }
  if (current.direction === 'desc') {
    return { column, direction: 'asc' };
  }
  return null;
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
