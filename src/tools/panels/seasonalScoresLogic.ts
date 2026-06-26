import { parseLinesOnePerLine } from '../parseToolLines';

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
};

export type SeasonSpec = {
  label: string;
  season: string | null;
  year: number;
};

/**
 * `all` / `allseasons` substitute a fixed magic seasonText so the user can pick
 * a sensible default without typing. `custom` falls through to whatever they
 * type in the textarea (the existing free-form input).
 */
export type SeasonMode = 'all' | 'allseasons' | 'custom';

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

/** Background tint for scored list entries: >8 green, <7 pink. */
export function scoreDisplayTone(
  score: number | null | undefined,
): ScoreDisplayTone | null {
  const normalized = normalizeSeasonalListScore(score);
  if (normalized == null) {
    return null;
  }
  if (normalized > 8) {
    return 'high';
  }
  if (normalized < 7) {
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

export function formatSeasonalScoreLabel(
  score: number | null | undefined,
  listStatus?: string | null,
): string {
  if (isSeasonalPlanningShow({ listStatus })) {
    return 'P';
  }
  const normalized = normalizeSeasonalListScore(score);
  return normalized == null ? '—' : String(normalized);
}

export function countRatedSeasonalShows(shows: SeasonalShow[]): number {
  return shows.reduce((count, show) => {
    if (isSeasonalPlanningShow(show)) {
      return count;
    }
    return count + (normalizeSeasonalListScore(show.score) == null ? 0 : 1);
  }, 0);
}

function seasonalShowSortKey(show: SeasonalShow): number {
  if (isSeasonalPlanningShow(show)) {
    return -1;
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

/** Span mode: show is in this column only because airing dates overlap. */
export function isExtendedSeasonPlacement(
  show: SeasonalShow,
  spec: SeasonSpec,
  spanAiringSeasons: boolean,
): boolean {
  if (!spanAiringSeasons) {
    return false;
  }
  return !matchesSeasonYearAndTag(show, spec);
}

export function showMatchesSeasonSpec(
  show: SeasonalShow,
  spec: SeasonSpec,
  options: { spanAiringSeasons: boolean; now: Date },
): boolean {
  if (!options.spanAiringSeasons) {
    return matchesSeasonYearAndTag(show, spec);
  }
  const airing = resolveShowAiringInterval(show, options.now);
  if (airing == null) {
    return matchesSeasonYearAndTag(show, spec);
  }
  return intervalsOverlap(airing, seasonSpecCalendarInterval(spec));
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
    .filter((show) => !isSeasonalPlanningShow(show))
    .map((s) => normalizeSeasonalListScore(s.score))
    .filter((s): s is number => s !== null);
  if (scored.length === 0) {
    return null;
  }
  const sum = scored.reduce((acc, n) => acc + n, 0);
  return Math.round((sum / scored.length) * 1000) / 1000;
}

export type BuildSeasonalColumnsOptions = {
  /** Injectable clock for spanning-mode tests. */
  now?: Date;
};

export function buildSeasonalColumns(
  shows: SeasonalShow[],
  form: SeasonalScoresForm,
  options?: BuildSeasonalColumnsOptions,
): SeasonalScoresResult {
  const now = options?.now ?? new Date();
  const specs = parseSeasonSpecs(form.seasonText, shows);
  if (specs.length === 0) {
    // Disambiguate so the user knows whether to type a season or
    // refresh — the `all`/`allseasons` presets only fail to emit specs
    // when the fetched list itself has no usable seasonYear values.
    const trimmed = form.seasonText.trim().toLowerCase();
    const isPreset = trimmed === 'all' || trimmed === 'allseasons';
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
          'None of the fetched shows have a season/year — try the Custom mode and enter seasons manually.',
      };
    }
    return { kind: 'empty', message: 'Enter at least one season or year to compare.' };
  }

  const columns: SeasonColumn[] = [];
  for (const spec of specs) {
    const bucket = bucketShowsForSeason(
      shows,
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
      ratedCount: countRatedSeasonalShows(bucket),
      average: averageScore(bucket),
      shows: bucket.map((show) => ({
        id: show.id,
        title: show.title,
        coverImage: show.coverImage ?? null,
        score: normalizeSeasonalListScore(show.score),
        listStatus: show.listStatus ?? null,
        extendedPlacement: isExtendedSeasonPlacement(show, spec, form.spanAiringSeasons),
      })),
    });
  }

  if (columns.length === 0) {
    return { kind: 'empty', message: 'No scored shows matched those seasons.' };
  }

  return { kind: 'columns', columns };
}
