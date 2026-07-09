import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelSeasonalShows } from '../toolsDisplayRelabel';
import { fetchUserSeasonalShows, bustSeasonalSessionMemo } from './seasonalScoresApi';
import {
  buildSeasonalColumns,
  countSeasonalShowsBySourceBucket,
  DEFAULT_SEASONAL_SOURCE_FILTERS,
  applySeasonalSourceFilters,
  effectiveSeasonalForm,
  formatSeasonColumnLabel,
  formatSeasonalScoreLabel,
  normalizeSeasonalSourceFilters,
  scoreDisplayToneClass,
  SEASONAL_SOURCE_FILTER_KEYS,
  seasonColumnIndicesWithTopAverage,
  seasonalSourceFilterLabel,
  type SeasonalSourceFilterKey,
  type SeasonMode,
  type SeasonalScoresForm,
  type SeasonalScoresResult,
  type SeasonalSourceFilters,
  type SeasonColumn,
  type SeasonalShow,
} from './seasonalScoresLogic';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import { applyHeaderScrollbarGutter } from '../../lib/chartSplitTableSync';
import {
  anilistUrlForSeasonSearch,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { MultiSelectChip, toggleInArray } from '../../lib/importers/anilist/filters';

const LS_KEY = 'anime-tools-seasonal-scores-form';
const LS_SOURCE_FILTERS_KEY = 'anime-tools-seasonal-scores-source-filters';
/** @deprecated migrated into {@link LS_KEY} */
const LS_SEASON_TEXT_KEY = 'anime-tools-seasonal-scores-season-text';

const DEFAULT_FORM: SeasonalScoresForm = {
  username: '',
  seasonText: '',
  // Default new users to `allseasons` so first-run produces a useful chart
  // without forcing them to learn the textarea grammar.
  seasonMode: 'allseasons',
  skipEmpty: false,
  airingNotesOnly: false,
  includePlanning: false,
  spanAiringSeasons: false,
};

type PersistedSeasonalForm = Pick<
  SeasonalScoresForm,
  | 'seasonText'
  | 'seasonMode'
  | 'skipEmpty'
  | 'airingNotesOnly'
  | 'includePlanning'
  | 'spanAiringSeasons'
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

function loadForm(): SeasonalScoresForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSeasonalForm>;
      const seasonText = parsed.seasonText ?? '';
      return {
        ...DEFAULT_FORM,
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
        includePlanning: parsed.includePlanning ?? false,
        spanAiringSeasons: parsed.spanAiringSeasons ?? false,
        username: withLastAnilistUsername(''),
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
      seasonText: form.seasonText,
      seasonMode: form.seasonMode,
      skipEmpty: form.skipEmpty,
      airingNotesOnly: form.airingNotesOnly,
      includePlanning: form.includePlanning,
      spanAiringSeasons: form.spanAiringSeasons,
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

function SeasonalColumnsView({
  columns,
  onOpenMedia,
}: {
  columns: SeasonColumn[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
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

  const syncHeaderScroll = useCallback(
    (el: HTMLElement) => {
      if (headerRef.current) {
        headerRef.current.scrollLeft = el.scrollLeft;
      }
      syncSeasonLayout();
    },
    [syncSeasonLayout],
  );

  return (
    <div className="tool-season-columns">
      <div ref={headerRef} className="tool-chart-pinned-header tool-season-header-wrap">
        <div className="tool-season-header-row">
        {columns.map((col, colIdx) => {
          const searchLink = bindAnilistMiddleClick(
            col.matchAll
              ? anilistUrlForSeasonSearch(null, 0)
              : anilistUrlForSeasonSearch(col.season, col.year),
          );
          return (
            <div key={`head-${colIdx}-${col.label}`} className="tool-season-column">
              <div className="tool-season-col-head">
                <div
                  className={mergeAnilistLinkClass(
                    'tool-season-col-title',
                    searchLink.className,
                  )}
                  onMouseDown={searchLink.onMouseDown}
                  onAuxClick={searchLink.onAuxClick}
                  title="Middle-click to search this season on AniList"
                >
                  {formatSeasonColumnLabel(col.label, col.ratedCount)}
                </div>
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
                      className={[
                        'tool-season-title',
                        show.extendedPlacement ? 'tool-season-title--extended' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
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
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    onAfterRefresh: bustSeasonalSessionMemo,
  });
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<SeasonalScoresForm>(() => loadForm());
  const [sourceFilters, setSourceFilters] = useState<SeasonalSourceFilters>(() =>
    loadSourceFilters(),
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

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    saveSourceFilters(sourceFilters);
  }, [sourceFilters]);

  const buildColumns = useCallback(
    (shows: SeasonalShow[]) =>
      buildSeasonalColumns(relabelSeasonalShows(shows), effectiveSeasonalForm(form), {
        sourceFilters,
      }),
    [displayLabelRevision, form, sourceFilters],
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

  const visibleSourceCount =
    cachedShows == null
      ? null
      : applySeasonalSourceFilters(relabelSeasonalShows(cachedShows), sourceFilters).length;

  const sourceFilterCounts = useMemo(() => {
    if (!cachedShows) {
      return null;
    }
    return countSeasonalShowsBySourceBucket(relabelSeasonalShows(cachedShows));
  }, [cachedShows, displayLabelRevision]);

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
        <ToolUsernameField
          label="AniList username"
          value={form.username}
          disabled={running}
          refreshing={refreshingList}
          onChange={(username) => patchForm({ username })}
          onRefresh={() => refreshUsernameList(form.username, running)}
        />

        <div className="tool-field tool-seasonal-mode-field">
          <div
            className="tool-segmented"
            role="group"
            aria-labelledby="seasonal-scores-mode-label"
          >
            {SEASON_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={form.seasonMode === option.value ? 'active' : ''}
                aria-pressed={form.seasonMode === option.value}
                disabled={running}
                title={option.title}
                onClick={() => patchForm({ seasonMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
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
              onChange={(e) => patchForm({ airingNotesOnly: e.target.checked })}
            />
            Only #airing notes
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.includePlanning}
              disabled={running}
              onChange={(e) => patchForm({ includePlanning: e.target.checked })}
            />
            Include Planning
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.spanAiringSeasons}
              disabled={running}
              onChange={(e) => patchForm({ spanAiringSeasons: e.target.checked })}
              title="Place shows in every season column their broadcast dates overlap (ongoing shows extend through today)."
            />
            Span Airing Seasons
          </label>
          <MultiSelectChip<SeasonalSourceFilterKey>
            label="source"
            options={SEASONAL_SOURCE_FILTER_KEYS}
            selected={sourceFilters}
            formatOption={formatSourceFilterOption}
            menuStatus={
              cachedShows != null && visibleSourceCount != null
                ? `${visibleSourceCount} of ${cachedShows.length}`
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
          />
        </div>
      )}
    </section>
  );
}
