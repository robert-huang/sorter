import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { ToolSegmentedFilter } from '../ToolSegmentedFilter';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelSeasonalShows } from '../toolsDisplayRelabel';
import { fetchUserSeasonalShows, bustSeasonalSessionMemo } from './seasonalScoresApi';
import {
  buildSeasonalColumns,
  countSeasonalShowsBySourceBucket,
  DEFAULT_SEASONAL_SOURCE_FILTERS,
  applySeasonalFormatFilters,
  applySeasonalGenreFilters,
  applySeasonalListStatusFilters,
  applySeasonalSeasonYearFilters,
  countSeasonalShowsBy,
  discoverSeasonalGenres,
  normalizeSeasonalStringFilters,
  type SeasonalFormatFilters,
  type SeasonalGenreFilters,
  applySeasonalSourceFilters,
  applySeasonalYearFilters,
  discoverSeasonalSeasonYearEncoded,
  discoverSeasonalYears,
  effectiveSeasonalForm,
  formatSeasonColumnLabel,
  formatSeasonalScoreLabel,
  normalizeSeasonalListStatusFilters,
  normalizeSeasonalSeasonYearFilter,
  normalizeSeasonalSourceFilters,
  normalizeSeasonalYearFilters,
  scoreDisplayToneClass,
  SEASONAL_LIST_STATUS_OPTIONS,
  seasonColumnIndicesWithTopAverage,
  seasonalSourceFilterLabel,
  type SeasonalListStatus,
  type SeasonalListStatusFilters,
  type SeasonalSeasonYearFilter,
  type SeasonalSourceFilterKey,
  type SeasonalYearFilters,
  type SeasonMode,
  type SeasonalScoresForm,
  type SeasonalScoresResult,
  type SeasonalSourceFilters,
  type SeasonColumn,
  type SeasonalShow,
  SEASONAL_SOURCE_FILTER_KEYS,
} from './seasonalScoresLogic';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { formatRepeatSuffix, ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import { applyHeaderScrollbarGutter } from '../../lib/chartSplitTableSync';
import {
  anilistUrlForSeasonSearch,
} from '../../lib/importers/anilist/anilistLinks';
import { AnilistMiddleClickLink } from '../../lib/importers/anilist/AnilistMiddleClickLink';
import {
  formatOptionsForType,
  MultiSelectChip,
  normalizeSeasonYearRangeToOptions,
  seasonYearOptionsForSelectedYears,
  SeasonYearChip,
  toggleInArray,
} from '../../lib/importers/anilist/filters';
import { useCurrentAnilistFavourites } from '../useCurrentAnilistFavourites';
import { useToolsPreferences } from '../../hooks/useToolsPreferences';

const LS_KEY = 'anime-tools-seasonal-scores-form';
const LS_SOURCE_FILTERS_KEY = 'anime-tools-seasonal-scores-source-filters';
const LS_PRIMARY_FILTERS_KEY = 'anime-tools-seasonal-scores-primary-filters';
/** @deprecated migrated into {@link LS_KEY} */
const LS_SEASON_TEXT_KEY = 'anime-tools-seasonal-scores-season-text';
const DEFAULT_NOTES_FILTER = '#airing';
const ANIME_FORMAT_OPTIONS: readonly string[] = formatOptionsForType('ANIME');

const DEFAULT_FORM: SeasonalScoresForm = {
  username: '',
  seasonText: '',
  // Default new users to `allseasons` so first-run produces a useful chart
  // without forcing them to learn the textarea grammar.
  seasonMode: 'allseasons',
  skipEmpty: false,
  airingNotesOnly: false,
  notesFilter: DEFAULT_NOTES_FILTER,
  includePlanning: false,
  spanAiringSeasons: false,
};

type PersistedSeasonalForm = Pick<
  SeasonalScoresForm,
  | 'username'
  | 'seasonText'
  | 'seasonMode'
  | 'skipEmpty'
  | 'airingNotesOnly'
  | 'notesFilter'
  | 'includePlanning'
>;

function normalizeSeasonMode(value: unknown): SeasonMode {
  if (value === 'alltime' || value === 'all' || value === 'allseasons' || value === 'custom') {
    return value;
  }
  return 'allseasons';
}

function loadSourceFilters(): SeasonalSourceFilters {
  try {
    const raw = localStorage.getItem(LS_SOURCE_FILTERS_KEY);
    if (!raw) {
      return [...DEFAULT_SEASONAL_SOURCE_FILTERS];
    }
    return normalizeSeasonalSourceFilters(JSON.parse(raw));
  } catch {
    return [...DEFAULT_SEASONAL_SOURCE_FILTERS];
  }
}

function saveSourceFilters(filters: SeasonalSourceFilters): void {
  try {
    localStorage.setItem(LS_SOURCE_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

type PersistedPrimaryFilters = {
  seasonYearMin?: unknown;
  seasonYearMax?: unknown;
  listStatuses?: unknown;
  years?: unknown;
  genres?: unknown;
  formats?: unknown;
};

type PrimaryFilters = {
  seasonYearFilter: SeasonalSeasonYearFilter;
  listStatusFilters: SeasonalListStatusFilters;
  yearFilters: SeasonalYearFilters;
  genreFilters: SeasonalGenreFilters;
  formatFilters: SeasonalFormatFilters;
};

function parsePrimaryFilters(parsed: PersistedPrimaryFilters): PrimaryFilters {
  return {
    seasonYearFilter: normalizeSeasonalSeasonYearFilter({
      seasonYearMin: parsed.seasonYearMin,
      seasonYearMax: parsed.seasonYearMax,
    }),
    listStatusFilters: normalizeSeasonalListStatusFilters(parsed.listStatuses),
    yearFilters: normalizeSeasonalYearFilters(parsed.years),
    genreFilters: normalizeSeasonalStringFilters(parsed.genres),
    formatFilters: normalizeSeasonalStringFilters(parsed.formats),
  };
}

function loadPrimaryFilters(): PrimaryFilters {
  try {
    const raw = localStorage.getItem(LS_PRIMARY_FILTERS_KEY);
    return parsePrimaryFilters(raw ? (JSON.parse(raw) as PersistedPrimaryFilters) : {});
  } catch {
    return parsePrimaryFilters({});
  }
}

function savePrimaryFilters(filters: PrimaryFilters): void {
  try {
    localStorage.setItem(
      LS_PRIMARY_FILTERS_KEY,
      JSON.stringify({
        seasonYearMin: filters.seasonYearFilter.seasonYearMin,
        seasonYearMax: filters.seasonYearFilter.seasonYearMax,
        listStatuses: filters.listStatusFilters,
        years: filters.yearFilters,
        genres: filters.genreFilters,
        formats: filters.formatFilters,
      }),
    );
  } catch {
    /* ignore */
  }
}

function loadForm(): SeasonalScoresForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSeasonalForm>;
      const seasonText = parsed.seasonText ?? '';
      return {
        ...DEFAULT_FORM,
        username: withLastAnilistUsername(parsed.username ?? ''),
        seasonText,
        // Pre-toggle saves don't carry a mode — preserve the user's previous
        // textarea content by inferring `custom` when text exists, otherwise
        // fall through to the default.
        seasonMode:
          parsed.seasonMode != null
            ? normalizeSeasonMode(parsed.seasonMode)
            : seasonText.trim().length > 0
              ? 'custom'
              : DEFAULT_FORM.seasonMode,
        skipEmpty: parsed.skipEmpty ?? false,
        airingNotesOnly: parsed.airingNotesOnly ?? false,
        notesFilter:
          typeof parsed.notesFilter === 'string'
            ? parsed.notesFilter
            : DEFAULT_NOTES_FILTER,
        includePlanning: parsed.includePlanning ?? false,
      };
    }
    const legacySeasonText = localStorage.getItem(LS_SEASON_TEXT_KEY) ?? '';
    return {
      ...DEFAULT_FORM,
      username: withLastAnilistUsername(''),
      seasonText: legacySeasonText,
      seasonMode: legacySeasonText.trim().length > 0 ? 'custom' : DEFAULT_FORM.seasonMode,
    };
  } catch {
    return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
  }
}

function saveForm(form: SeasonalScoresForm): void {
  try {
    const persisted: PersistedSeasonalForm = {
      username: form.username,
      seasonText: form.seasonText,
      seasonMode: form.seasonMode,
      skipEmpty: form.skipEmpty,
      airingNotesOnly: form.airingNotesOnly,
      notesFilter: form.notesFilter,
      includePlanning: form.includePlanning,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

const SEASON_MODE_OPTIONS: { value: SeasonMode; label: string; title: string }[] = [
  {
    value: 'alltime',
    label: 'All Time',
    title: 'Merge the full list into one column (ignores season/year buckets).',
  },
  { value: 'all', label: 'All (Years)', title: "Compare full years from the user's list range." },
  {
    value: 'allseasons',
    label: 'All (Seasons)',
    title: "Split the user's list range into Winter/Spring/Summer/Fall columns.",
  },
  { value: 'custom', label: 'Custom', title: 'Type your own season list (one per line).' },
];

export function SeasonalColumnsView({
  columns,
  onOpenMedia,
  showRepeats = false,
}: {
  columns: SeasonColumn[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  showRepeats?: boolean;
}) {
  const favourites = useCurrentAnilistFavourites();
  const topAverageColumnIndices = seasonColumnIndicesWithTopAverage(columns);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);

  const syncSeasonLayout = useCallback(() => {
    if (headerRef.current && bodyScrollRef.current) {
      applyHeaderScrollbarGutter(headerRef.current, bodyScrollRef.current);
      headerRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
    }
  }, []);

  useLayoutEffect(() => {
    const sync = () => {
      syncSeasonLayout();
    };
    sync();
    // Run again after DragScroll's initialScrollEnd layout pass.
    const frameId = requestAnimationFrame(sync);
    const bodyScroll = bodyScrollRef.current;
    if (!bodyScroll) {
      return () => {
        cancelAnimationFrame(frameId);
      };
    }
    const observer = new ResizeObserver(() => {
      syncSeasonLayout();
    });
    observer.observe(bodyScroll);
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [columns, syncSeasonLayout]);

  const syncHeaderScroll = useCallback((el: HTMLElement) => {
    if (headerRef.current) {
      headerRef.current.scrollLeft = el.scrollLeft;
    }
  }, []);

  return (
    <div className="tool-season-columns">
      <div ref={headerRef} className="tool-chart-pinned-header tool-season-header-wrap">
        <div className="tool-season-header-row">
        {columns.map((col, colIdx) => {
          const searchUrl = col.matchAll
            ? anilistUrlForSeasonSearch(null, 0)
            : anilistUrlForSeasonSearch(col.season, col.year);
          return (
            <div key={`head-${colIdx}-${col.label}`} className="tool-season-column">
              <div className="tool-season-col-head">
                <AnilistMiddleClickLink
                  url={searchUrl}
                  className="tool-season-col-title"
                  title="Middle-click to search this season on AniList"
                >
                  {formatSeasonColumnLabel(col.label, col.ratedCount)}
                </AnilistMiddleClickLink>
                <div
                  className={[
                    'tool-season-col-avg',
                    scoreDisplayToneClass(col.average),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  avg: {col.average ?? 'N/A'}
                  {topAverageColumnIndices.has(colIdx) ? (
                    <span
                      className="tool-season-col-avg-star"
                      title="Highest average in this chart"
                      aria-hidden="true"
                    >
                      ★
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      </div>
      <DragScroll
        className="tool-season-scroll"
        initialScrollEnd
        scrollAnchorSelector="[data-scroll-anchor]"
        scrollRef={bodyScrollRef}
        onUserScroll={syncHeaderScroll}
      >
        <div className="tool-season-body">
          {columns.map((col, colIdx) => (
            <div
              key={`${colIdx}-${col.label}`}
              className="tool-season-column"
              data-scroll-anchor={col.label}
              data-scroll-anchor-year={col.year}
            >
              {col.shows.map((show) => (
                <div key={show.id} className="tool-season-cell">
                  <div className="tool-season-cell-grid">
                    <span
                      className={[
                        'tool-season-score',
                        scoreDisplayToneClass(show.score),
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {formatSeasonalScoreLabel(show.score, show.listStatus)}
                    </span>
                    <ToolShowButton
                      mediaId={show.id}
                      title={show.title}
                      coverImage={show.coverImage}
                      onOpenMedia={onOpenMedia}
                      compact
                      favourite={favourites.mediaIds.has(show.id)}
                      className={[
                        'tool-season-title',
                        show.extendedPlacement ? 'tool-season-title--extended' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      labelSuffix={
                        showRepeats && formatRepeatSuffix(show.repeat) ? (
                          <span className="tool-stats-repeat">
                            {formatRepeatSuffix(show.repeat)}
                          </span>
                        ) : undefined
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DragScroll>
    </div>
  );
}

export function SeasonalScoresPanel({ onOpenMedia }: ToolPanelProps) {
  const { prefs: toolsPreferences } = useToolsPreferences();
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    onAfterRefresh: bustSeasonalSessionMemo,
  });
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<SeasonalScoresForm>(() => loadForm());
  const [sourceFilters, setSourceFilters] = useState<SeasonalSourceFilters>(() =>
    loadSourceFilters(),
  );
  const [initialPrimaryFilters] = useState(loadPrimaryFilters);
  const [seasonYearFilter, setSeasonYearFilter] = useState<SeasonalSeasonYearFilter>(
    initialPrimaryFilters.seasonYearFilter,
  );
  const [yearFilters, setYearFilters] = useState<SeasonalYearFilters>(
    initialPrimaryFilters.yearFilters,
  );
  const [listStatusFilters, setListStatusFilters] =
    useState<SeasonalListStatusFilters>(
      initialPrimaryFilters.listStatusFilters,
    );
  const [genreFilters, setGenreFilters] = useState<SeasonalGenreFilters>(
    initialPrimaryFilters.genreFilters,
  );
  const [formatFilters, setFormatFilters] = useState<SeasonalFormatFilters>(
    initialPrimaryFilters.formatFilters,
  );
  const [cachedShows, setCachedShows] = useState<SeasonalShow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped only on a successful list fetch so the chart remounts and snaps right once. */
  const chartSessionRef = useRef(0);
  // Username at fetch time so a different user typed in can clear the
  // cached shows. The PLANNING dimension used to live here too; it now
  // doesn't — every fetch includes PLANNING and the checkbox filters
  // client-side via `bucketShowsForSeason`.
  const fetchedUsernameRef = useRef<string | null>(null);
  const primaryFiltersUsernameRef = useRef<string | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    saveSourceFilters(sourceFilters);
  }, [sourceFilters]);

  const relabeledCachedShows = useMemo(
    () => (cachedShows == null ? null : relabelSeasonalShows(cachedShows)),
    [cachedShows, displayLabelRevision],
  );

  const yearOptions = useMemo(
    () =>
      relabeledCachedShows == null
        ? []
        : discoverSeasonalYears(relabeledCachedShows),
    [relabeledCachedShows],
  );

  const discoveredSeasonYearEncodedOptions = useMemo(
    () =>
      relabeledCachedShows == null
        ? []
        : discoverSeasonalSeasonYearEncoded(relabeledCachedShows),
    [relabeledCachedShows],
  );

  const seasonYearEncodedOptions = useMemo(
    () =>
      seasonYearOptionsForSelectedYears(
        discoveredSeasonYearEncodedOptions,
        yearFilters,
      ),
    [discoveredSeasonYearEncodedOptions, yearFilters],
  );

  useEffect(() => {
    if (relabeledCachedShows == null) {
      primaryFiltersUsernameRef.current = null;
      return;
    }
    const handle = form.username.trim().toLowerCase();
    if (primaryFiltersUsernameRef.current === handle) {
      return;
    }
    const persisted = loadPrimaryFilters();
    setSeasonYearFilter(persisted.seasonYearFilter);
    setYearFilters(persisted.yearFilters);
    setListStatusFilters(persisted.listStatusFilters);
    setGenreFilters(persisted.genreFilters);
    setFormatFilters(persisted.formatFilters);
    primaryFiltersUsernameRef.current = handle;
  }, [relabeledCachedShows, form.username]);

  useEffect(() => {
    savePrimaryFilters({
      seasonYearFilter,
      listStatusFilters,
      yearFilters,
      genreFilters,
      formatFilters,
    });
  }, [seasonYearFilter, listStatusFilters, yearFilters, genreFilters, formatFilters]);

  const buildColumns = useCallback(
    (shows: SeasonalShow[]) =>
      buildSeasonalColumns(
        relabelSeasonalShows(shows),
        effectiveSeasonalForm({
          ...form,
          spanAiringSeasons:
            toolsPreferences.seasonalScoresSpanAiringSeasons,
        }),
        {
          yearFilters,
          seasonYearFilter,
          listStatusFilters,
          genreFilters,
          formatFilters,
          sourceFilters,
          includeRepeats: toolsPreferences.seasonalScoresShowRepeats,
        },
      ),
    [
      displayLabelRevision,
      form,
      sourceFilters,
      yearFilters,
      seasonYearFilter,
      listStatusFilters,
      genreFilters,
      formatFilters,
      toolsPreferences.seasonalScoresShowRepeats,
      toolsPreferences.seasonalScoresSpanAiringSeasons,
    ],
  );

  const result = useMemo((): SeasonalScoresResult | null => {
    if (!cachedShows) {
      return null;
    }
    const handle = form.username.trim().toLowerCase();
    if (fetchedUsernameRef.current !== null && handle !== fetchedUsernameRef.current) {
      return null;
    }
    return buildColumns(cachedShows);
  }, [cachedShows, buildColumns, form.username]);

  const patchForm = useCallback((patch: Partial<SeasonalScoresForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const onRun = useCallback(async (forceRefresh = false) => {
    const username = form.username.trim();
    if (!username) {
      setError('Enter an AniList username.');
      setCachedShows(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const handle = username.toLowerCase();

    setRunning(true);
    setError(null);
    setCachedShows(null);

    try {
      const shows = await fetchUserSeasonalShows(
        username,
        controller.signal,
        forceRefresh ? { forceRefresh: true } : undefined,
      );
      setCachedShows(shows);
      fetchedUsernameRef.current = handle;
      chartSessionRef.current += 1;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load list.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }, [form.username]);

  useEffect(() => {
    const handle = form.username.trim().toLowerCase();
    if (
      cachedShows != null &&
      fetchedUsernameRef.current !== null &&
      handle !== fetchedUsernameRef.current
    ) {
      setCachedShows(null);
      fetchedUsernameRef.current = null;
    }
  }, [form.username, cachedShows]);

  const visibleYearCount =
    relabeledCachedShows == null
      ? null
      : applySeasonalYearFilters(relabeledCachedShows, yearFilters).length;

  // Shows left after each chip, applied in buildSeasonalColumns order.
  const visibleCounts = useMemo(() => {
    if (relabeledCachedShows == null) {
      return null;
    }
    let shows = applySeasonalSeasonYearFilters(
      applySeasonalYearFilters(relabeledCachedShows, yearFilters),
      seasonYearFilter,
    );
    shows = applySeasonalListStatusFilters(shows, listStatusFilters);
    const listStatus = shows.length;
    shows = applySeasonalGenreFilters(shows, genreFilters);
    const genre = shows.length;
    shows = applySeasonalFormatFilters(shows, formatFilters);
    const format = shows.length;
    const source = applySeasonalSourceFilters(shows, sourceFilters).length;
    return { listStatus, genre, format, source };
  }, [
    relabeledCachedShows,
    yearFilters,
    seasonYearFilter,
    listStatusFilters,
    genreFilters,
    formatFilters,
    sourceFilters,
  ]);
  const visibleListStatusCount = visibleCounts?.listStatus ?? null;
  const visibleSourceCount = visibleCounts?.source ?? null;

  const genreOptions = useMemo(
    () => (relabeledCachedShows == null ? [] : discoverSeasonalGenres(relabeledCachedShows)),
    [relabeledCachedShows],
  );

  const genreFilterCounts = useMemo(
    () =>
      relabeledCachedShows == null
        ? null
        : countSeasonalShowsBy(relabeledCachedShows, (show) => show.genres ?? []),
    [relabeledCachedShows],
  );

  const formatFilterCounts = useMemo(
    () =>
      relabeledCachedShows == null
        ? null
        : countSeasonalShowsBy(relabeledCachedShows, (show) =>
            show.format ? [show.format] : [],
          ),
    [relabeledCachedShows],
  );

  const formatGenreFilterOption = useCallback(
    (genre: string) =>
      genreFilterCounts ? `${genre} (${genreFilterCounts.get(genre) ?? 0})` : genre,
    [genreFilterCounts],
  );

  const formatFormatFilterOption = useCallback(
    (format: string) =>
      formatFilterCounts ? `${format} (${formatFilterCounts.get(format) ?? 0})` : format,
    [formatFilterCounts],
  );

  const sourceFilterCounts = useMemo(() => {
    if (!relabeledCachedShows) {
      return null;
    }
    return countSeasonalShowsBySourceBucket(relabeledCachedShows);
  }, [relabeledCachedShows]);

  const listStatusFilterCounts = useMemo(() => {
    if (!relabeledCachedShows) {
      return null;
    }
    const counts = new Map<SeasonalListStatus, number>();
    for (const show of relabeledCachedShows) {
      const status = show.listStatus;
      if (status == null || !SEASONAL_LIST_STATUS_OPTIONS.includes(status as SeasonalListStatus)) {
        continue;
      }
      const key = status as SeasonalListStatus;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [relabeledCachedShows]);

  const formatListStatusFilterOption = useCallback(
    (status: SeasonalListStatus) => {
      if (!listStatusFilterCounts) {
        return status;
      }
      return `${status} (${listStatusFilterCounts.get(status) ?? 0})`;
    },
    [listStatusFilterCounts],
  );

  const formatSourceFilterOption = useCallback(
    (key: SeasonalSourceFilterKey) => {
      const label = seasonalSourceFilterLabel(key);
      if (!sourceFilterCounts) {
        return label;
      }
      return `${label} (${sourceFilterCounts[key]})`;
    },
    [sourceFilterCounts],
  );

  const replaceYearFilters = useCallback(
    (years: readonly number[]) => {
      const nextYears = [...years];
      const nextOptions = seasonYearOptionsForSelectedYears(
        discoveredSeasonYearEncodedOptions,
        nextYears,
      );
      setYearFilters(nextYears);
      setSeasonYearFilter((previous) =>
        normalizeSeasonYearRangeToOptions(
          nextOptions,
          previous.seasonYearMin,
          previous.seasonYearMax,
        ),
      );
    },
    [discoveredSeasonYearEncodedOptions],
  );

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Compare average scores across seasons from a user&apos;s list — port of{' '}
        <code>compare_seasons.py</code>.
      </p>

      <form
        className="tool-form-card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) {
            void onRun(false);
          }
        }}
      >
        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters">
          <ToolUsernameField
            label="User"
            value={form.username}
            disabled={running}
            refreshing={refreshingList}
            onChange={(username) => patchForm({ username })}
            onRefresh={() => refreshUsernameList(form.username, running)}
          />
          <MultiSelectChip
            label="year"
            options={yearOptions}
            selected={yearFilters}
            menuStatus={
              relabeledCachedShows != null && visibleYearCount != null
                ? `${visibleYearCount} of ${relabeledCachedShows.length}`
                : undefined
            }
            onToggle={(year) =>
              replaceYearFilters(toggleInArray(yearFilters, year))
            }
            onReplaceAll={replaceYearFilters}
          />
          <SeasonYearChip
            options={seasonYearEncodedOptions}
            min={seasonYearFilter.seasonYearMin}
            max={seasonYearFilter.seasonYearMax}
            onChange={(patch) =>
              setSeasonYearFilter((prev) => ({
                seasonYearMin:
                  patch.seasonYearMin !== undefined ? patch.seasonYearMin : prev.seasonYearMin,
                seasonYearMax:
                  patch.seasonYearMax !== undefined ? patch.seasonYearMax : prev.seasonYearMax,
              }))
            }
          />
          <MultiSelectChip
            label="list status"
            options={SEASONAL_LIST_STATUS_OPTIONS}
            selected={listStatusFilters}
            formatOption={formatListStatusFilterOption}
            menuStatus={
              relabeledCachedShows != null && visibleListStatusCount != null
                ? `${visibleListStatusCount} of ${relabeledCachedShows.length}`
                : undefined
            }
            onToggle={(status) =>
              setListStatusFilters((prev) => toggleInArray(prev, status))
            }
            onReplaceAll={(statuses) => setListStatusFilters([...statuses])}
          />
          <MultiSelectChip
            label="genre"
            options={genreOptions}
            selected={genreFilters}
            formatOption={formatGenreFilterOption}
            menuStatus={
              relabeledCachedShows != null && visibleCounts != null
                ? `${visibleCounts.genre} of ${relabeledCachedShows.length}`
                : undefined
            }
            onToggle={(genre) => setGenreFilters((prev) => toggleInArray(prev, genre))}
            onReplaceAll={(genres) => setGenreFilters([...genres])}
          />
          <MultiSelectChip<string>
            label="format"
            options={ANIME_FORMAT_OPTIONS}
            selected={formatFilters}
            formatOption={formatFormatFilterOption}
            menuStatus={
              relabeledCachedShows != null && visibleCounts != null
                ? `${visibleCounts.format} of ${relabeledCachedShows.length}`
                : undefined
            }
            onToggle={(format) => setFormatFilters((prev) => toggleInArray(prev, format))}
            onReplaceAll={(formats) => setFormatFilters([...formats])}
          />
        </div>

        <div className="tool-field tool-seasonal-mode-field">
          <ToolSegmentedFilter
            labelId="seasonal-scores-mode-label"
            options={SEASON_MODE_OPTIONS}
            value={form.seasonMode}
            disabled={running}
            unlabeled
            onChange={(seasonMode) => patchForm({ seasonMode })}
          />
          {form.seasonMode === 'custom' && (
            <>
              <span className="tool-field-hint">
                One per line: <code>alltime</code>, <code>all</code>, <code>allseasons</code>,{' '}
                <code>Winter 2024</code>, <code>2018</code>
              </span>
              <textarea
                className="tool-textarea csv-textarea"
                rows={6}
                disabled={running}
                value={form.seasonText}
                onChange={(e) => patchForm({ seasonText: e.target.value })}
                placeholder={'Winter 2024\nSpring 2024\nSummer 2024'}
              />
            </>
          )}
        </div>

        <div className="tool-field-row tool-field-row-wrap">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.skipEmpty}
              disabled={running}
              onChange={(e) => patchForm({ skipEmpty: e.target.checked })}
            />
            Skip empty seasons
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.airingNotesOnly}
              disabled={running}
              onChange={(e) =>
                patchForm({
                  airingNotesOnly: e.target.checked,
                  notesFilter: DEFAULT_NOTES_FILTER,
                })
              }
            />
            Notes filter
          </label>
          {form.airingNotesOnly ? (
            <input
              type="text"
              className="slot-search tool-seasonal-notes-filter-input"
              value={form.notesFilter}
              disabled={running}
              aria-label="Notes filter text"
              onChange={(e) => patchForm({ notesFilter: e.target.value })}
            />
          ) : null}
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.includePlanning}
              disabled={running}
              onChange={(e) => patchForm({ includePlanning: e.target.checked })}
            />
            Include Planning
          </label>
          <MultiSelectChip<SeasonalSourceFilterKey>
            label="source"
            options={SEASONAL_SOURCE_FILTER_KEYS}
            selected={sourceFilters}
            formatOption={formatSourceFilterOption}
            menuStatus={
              relabeledCachedShows != null && visibleSourceCount != null
                ? `${visibleSourceCount} of ${relabeledCachedShows.length}`
                : undefined
            }
            onToggle={(value) =>
              setSourceFilters((prev) => toggleInArray(prev, value))
            }
            onReplaceAll={(values) => setSourceFilters([...values])}
          />
        </div>

        <div className="tool-actions">
          <ToolRunButton
            label="Compare"
            running={running}
            onRun={(forceRefresh) => void onRun(forceRefresh)}
          />
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {running && <p className="tool-status">Loading user list…</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result?.kind === 'empty' && <p className="tool-empty">{result.message}</p>}

      {result?.kind === 'columns' && (
        <div className="tool-chart-fullbleed tool-season-fullbleed">
          <SeasonalColumnsView
            key={chartSessionRef.current}
            columns={result.columns}
            onOpenMedia={onOpenMedia}
            showRepeats={toolsPreferences.seasonalScoresShowRepeats}
          />
        </div>
      )}
    </section>
  );
}
