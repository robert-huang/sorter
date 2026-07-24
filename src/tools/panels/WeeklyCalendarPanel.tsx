import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { MultiSelectChip, DualRangeSlider, toggleInArray } from '../../lib/importers/anilist/filters';
import { useClickOutside } from '../../lib/hooks/useClickOutside';
import { ToolShowButton, ToolEntityAvatar } from '../toolEntityLinks';
import {
  anilistUrlForMediaEntry,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { DragScroll } from '../../components/DragScroll';
import { applyHeaderScrollbarGutter } from '../../lib/chartSplitTableSync';
import {
  bustWeeklyCalendarUserListMemo,
  fetchWeeklyCalendarSeasonsEntries,
  fetchWeeklyCalendarWatchingEntries,
} from './weeklyCalendarApi';
import { productionReads } from '../../lib/importers/anilist/readQueries';
import { runAnilistMediaThemeSongsExpansion } from '../../lib/importers/anilist/runners';
import {
  groupThemeRowsByType,
  THEME_SONG_SECTION_LABEL,
} from '../../lib/importers/anilist/themeSongs/themeSongDisplay';
import {
  THEME_SONG_TYPE_ORDER,
  type MediaThemeSongRow,
  type MediaThemeSongsPayload,
  type ThemeSongType,
} from '../../lib/importers/anilist/themeSongs/types';
import {
  aggregatePlaylistMatchForRows,
  matchThemeRowToPlaylist,
  type PlaylistAggregateStatus,
} from '../../lib/spotify/spotifyPlaylistMatch';
import { useSpotifyPlaylistCache } from '../../lib/spotify/useSpotifyPlaylistCache';
import { ThemeSongRowC } from '../../components/themeSongRowC';
import {
  DEFAULT_WEEKLY_CALENDAR_FORM,
  buildWeeklyCalendarCustomSeasonYearOptions,
  collectWeeklyCalendarMediaIds,
  collectWeeklyCalendarShows,
  decodeAnilistSeasonEncoded,
  defaultWeeklyCalendarCustomSeasonRange,
  finalizeWeeklyCalendarResult,
  formatAnilistSeasonLabel,
  formatWeeklyCalendarDetailLines,
  formatWeeklyCalendarListStatusFilterLabel,
  formatWeeklyCalendarMediaStatusFilterLabel,
  getCurrentAnilistSeason,
  getNextAnilistSeason,
  normalizeCustomSeasonRange,
  normalizeWeeklyCalendarMediaStatusFilters,
  resolveWeeklyCalendarSeasonSpecs,
  weeklyCalendarTimezoneToIana,
  WEEKLY_CALENDAR_LIST_STATUS_OPTIONS,
  WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS,
  type WeeklyCalendarForm,
  type WeeklyCalendarListStatusFilter,
  type WeeklyCalendarMediaStatusFilter,
  type WeeklyCalendarEntry,
  type WeeklyCalendarRawEntry,
  type WeeklyCalendarResult,
  type WeeklyCalendarTimezone,
  type WeeklyCalendarWeekStartDay,
} from './weeklyCalendarLogic';
import {
  formatSeasonalScoreLabel,
  scoreDisplayToneClass,
} from './seasonalScoresLogic';

const LS_KEY = 'anime-tools-weekly-calendar-form';

type PersistedWeeklyCalendarForm = Pick<
  WeeklyCalendarForm,
  | 'username'
  | 'weekStartDay'
  | 'timezone'
  | 'mediaStatusFilters'
  | 'showUnscheduledColumn'
  | 'showThemeSongs'
>;

const WEEK_START_OPTIONS: WeeklyCalendarWeekStartDay[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

const TIMEZONE_OPTIONS: Array<{ value: WeeklyCalendarTimezone; label: string }> = [
  { value: 'eastern', label: 'Eastern' },
  { value: 'pacific', label: 'Pacific' },
  { value: 'utc', label: 'UTC' },
  { value: 'local', label: 'Local' },
];

function loadForm(): WeeklyCalendarForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedWeeklyCalendarForm>;
      return {
        ...DEFAULT_WEEKLY_CALENDAR_FORM,
        ...defaultWeeklyCalendarCustomSeasonRange(),
        username: withLastAnilistUsername(parsed.username ?? ''),
        weekStartDay:
          parsed.weekStartDay && WEEK_START_OPTIONS.includes(parsed.weekStartDay)
            ? parsed.weekStartDay
            : DEFAULT_WEEKLY_CALENDAR_FORM.weekStartDay,
        timezone:
          parsed.timezone && TIMEZONE_OPTIONS.some((opt) => opt.value === parsed.timezone)
            ? parsed.timezone
            : DEFAULT_WEEKLY_CALENDAR_FORM.timezone,
        mediaStatusFilters: normalizeWeeklyCalendarMediaStatusFilters(parsed.mediaStatusFilters),
        showUnscheduledColumn: parsed.showUnscheduledColumn ?? false,
        showThemeSongs: parsed.showThemeSongs ?? false,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    ...DEFAULT_WEEKLY_CALENDAR_FORM,
    ...defaultWeeklyCalendarCustomSeasonRange(),
    username: withLastAnilistUsername(''),
  };
}

function saveForm(form: WeeklyCalendarForm): void {
  try {
    const persisted: PersistedWeeklyCalendarForm = {
      username: form.username,
      weekStartDay: form.weekStartDay,
      timezone: form.timezone,
      mediaStatusFilters: form.mediaStatusFilters,
      showUnscheduledColumn: form.showUnscheduledColumn,
      showThemeSongs: form.showThemeSongs,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

function WeeklyCalendarCustomSeasonChip({
  options,
  minEncoded,
  maxEncoded,
  onChange,
}: {
  options: readonly number[];
  minEncoded: number;
  maxEncoded: number;
  onChange: (patch: {
    customSeasonMinEncoded: number;
    customSeasonMaxEncoded: number;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));

  const range = normalizeCustomSeasonRange(minEncoded, maxEncoded, options);
  const loIdx = Math.max(0, options.indexOf(range.minEncoded));
  const hiIdx = Math.max(loIdx, options.indexOf(range.maxEncoded));
  const loLabel = formatAnilistSeasonLabel(decodeAnilistSeasonEncoded(range.minEncoded));
  const hiLabel = formatAnilistSeasonLabel(decodeAnilistSeasonEncoded(range.maxEncoded));
  const chipLabel =
    range.minEncoded === range.maxEncoded
      ? `seasonYear · ${loLabel}`
      : `seasonYear · ${loLabel} - ${hiLabel}`;

  return (
    <div ref={rootRef} className="filter-chip active">
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        title="Pick a season range"
      >
        {chipLabel}
      </button>
      {open && options.length > 0 ? (
        <div className="filter-chip-menu filter-chip-menu-wide" role="menu">
          <div className="filter-chip-slider-row tool-weekly-custom-season-slider-row">
            <DualRangeSlider
              min={0}
              max={options.length - 1}
              value={[loIdx, hiIdx]}
              ariaLabelMin="Custom season range minimum"
              ariaLabelMax="Custom season range maximum"
              onChange={([nextLoIdx, nextHiIdx]) => {
                const nextMin = options[nextLoIdx];
                const nextMax = options[nextHiIdx];
                if (nextMin != null && nextMax != null) {
                  onChange({
                    customSeasonMinEncoded: nextMin,
                    customSeasonMaxEncoded: nextMax,
                  });
                }
              }}
            />
          </div>
          <div className="filter-chip-slider-labels">
            <span>{loLabel}</span>
            <span>{hiLabel}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WeeklyCalendarPosterButton({
  mediaId,
  title,
  coverImage,
  onOpenMedia,
}: {
  mediaId: number;
  title: string;
  coverImage: string | null;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const anilistLink = bindAnilistMiddleClick(anilistUrlForMediaEntry('ANIME', mediaId));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass('tool-weekly-poster-btn', anilistLink.className)}
      title={title}
      onClick={() => onOpenMedia(mediaId, title)}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      <ToolEntityAvatar imageUrl={coverImage} label={title} variant="poster" />
    </button>
  );
}

function WeeklyCalendarThemeSongShowTitle({
  show,
  songCount,
  onOpenMedia,
}: {
  show: WeeklyCalendarEntry;
  songCount?: number;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const anilistLink = bindAnilistMiddleClick(anilistUrlForMediaEntry('ANIME', show.id));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass('tool-weekly-theme-songs-show-title', anilistLink.className)}
      title={`${show.title} (middle-click for AniList)`}
      onClick={() => onOpenMedia(show.id, show.title)}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      <ToolEntityAvatar imageUrl={show.coverImage} label={show.title} variant="poster" />
      <span className="tool-weekly-theme-songs-show-title-text">
        {show.title}
        {songCount != null ? (
          <span className="tool-weekly-theme-songs-show-count">({songCount})</span>
        ) : null}
      </span>
    </button>
  );
}

function WeeklyCalendarThemeSongGroups({
  rows,
  playlistCache,
}: {
  rows: readonly MediaThemeSongRow[];
  playlistCache: ReturnType<typeof useSpotifyPlaylistCache>;
}) {
  const rowsByType = groupThemeRowsByType(rows);
  const showPlaylistMatch = playlistCache !== null;

  return (
    <div className="anilist-detail-theme-songs tool-weekly-theme-song-groups-inner">
      {THEME_SONG_TYPE_ORDER.map((type: ThemeSongType) => {
        const typeRows = rowsByType[type];
        if (typeRows.length === 0) {
          return null;
        }
        return (
          <div key={type} className="anilist-detail-theme-group">
            <div className="anilist-detail-theme-group-label">
              {THEME_SONG_SECTION_LABEL[type]}
            </div>
            <ul className="anilist-detail-theme-song-list">
              {typeRows.map((row, index) => (
                <ThemeSongRowC
                  key={`${type}-${row.songKey ?? row.displayTitle}-${index}`}
                  row={row}
                  playlistStatus={matchThemeRowToPlaylist(row, playlistCache)}
                  showPlaylistMatch={showPlaylistMatch}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function WeeklyCalendarThemeSongsPanel({
  shows,
  themeSongCache,
  playlistCache,
  onOpenMedia,
  onRefreshThemeSongs,
  refreshingCached,
  refreshingPending,
}: {
  shows: WeeklyCalendarEntry[];
  themeSongCache: Map<number, MediaThemeSongsPayload>;
  playlistCache: ReturnType<typeof useSpotifyPlaylistCache>;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  onRefreshThemeSongs: (mediaIds: number[], kind: 'cached' | 'pending') => void;
  refreshingCached: boolean;
  refreshingPending: boolean;
}) {
  if (shows.length === 0) {
    return null;
  }

  const withCache = shows.filter((show) => {
    const payload = themeSongCache.get(show.id);
    return payload != null && payload.rows.length > 0;
  });
  const withoutCache = shows.filter((show) => !themeSongCache.has(show.id));

  return (
    <section className="tool-weekly-theme-songs-panel">
      <div className="tool-weekly-theme-songs-heading-row">
        <h3 className="tool-weekly-theme-songs-heading">Theme songs (cached)</h3>
        {withCache.length > 0 ? (
          <button
            type="button"
            className="btn small icon-only tool-weekly-theme-songs-refresh"
            onClick={() => onRefreshThemeSongs(withCache.map((show) => show.id), 'cached')}
            disabled={refreshingCached || refreshingPending}
            title="Re-fetch theme songs for all cached shows"
            aria-label="Refresh all cached theme songs"
          >
            {refreshingCached ? '…' : '↻'}
          </button>
        ) : null}
      </div>
      {withCache.length === 0 ? (
        <p className="tool-muted">
          No cached theme songs for shows in this chart. Open a show&apos;s detail modal to load
          them.
        </p>
      ) : (
        <div className="tool-weekly-theme-songs-groups">
          {withCache.map((show) => {
            const rows = themeSongCache.get(show.id)?.rows ?? [];
            return (
              <div key={show.id} className="tool-weekly-theme-songs-show">
                <WeeklyCalendarThemeSongShowTitle
                  show={show}
                  songCount={rows.length}
                  onOpenMedia={onOpenMedia}
                />
                <WeeklyCalendarThemeSongGroups
                  rows={rows}
                  playlistCache={playlistCache}
                />
              </div>
            );
          })}
        </div>
      )}
      {withoutCache.length > 0 ? (
        <div className="tool-weekly-theme-songs-pending">
          <p className="tool-weekly-theme-songs-pending-label">
            <span>Not loaded yet ({withoutCache.length})</span>
            <button
              type="button"
              className="btn small icon-only tool-weekly-theme-songs-refresh"
              onClick={() =>
                onRefreshThemeSongs(withoutCache.map((show) => show.id), 'pending')
              }
              disabled={refreshingCached || refreshingPending}
              title="Fetch theme songs for all not-yet-loaded shows"
              aria-label="Refresh all not loaded theme songs"
            >
              {refreshingPending ? '…' : '↻'}
            </button>
          </p>
          <ul className="tool-weekly-theme-songs-pending-list">
            {withoutCache.map((show) => (
              <li key={show.id}>
                <WeeklyCalendarThemeSongShowTitle show={show} onOpenMedia={onOpenMedia} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function themeSongBadgeTitle(
  count: number,
  playlistStatus: PlaylistAggregateStatus | null,
): string {
  const base = `${count} cached theme song${count === 1 ? '' : 's'}`;
  if (playlistStatus === 'in') {
    return `${base} — all on your Spotify playlist`;
  }
  if (playlistStatus === 'out') {
    return `${base} — none on your Spotify playlist`;
  }
  if (playlistStatus === 'mixed') {
    return `${base} — some on your Spotify playlist`;
  }
  return base;
}

function WeeklyCalendarColumnsView({
  result,
  timeZone,
  showThemeSongs,
  themeSongCounts,
  themeSongCache,
  playlistCache,
  onOpenMedia,
}: {
  result: Extract<WeeklyCalendarResult, { kind: 'columns' }>;
  timeZone: string | undefined;
  showThemeSongs: boolean;
  themeSongCounts: ReadonlyMap<number, number>;
  themeSongCache: Map<number, MediaThemeSongsPayload>;
  playlistCache: ReturnType<typeof useSpotifyPlaylistCache>;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);

  const syncLayout = useCallback(() => {
    if (headerRef.current && bodyScrollRef.current) {
      applyHeaderScrollbarGutter(headerRef.current, bodyScrollRef.current);
      headerRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
    }
  }, []);

  useLayoutEffect(() => {
    const sync = () => {
      syncLayout();
    };
    sync();
    const frameId = requestAnimationFrame(sync);
    const bodyScroll = bodyScrollRef.current;
    if (!bodyScroll) {
      return () => {
        cancelAnimationFrame(frameId);
      };
    }
    const observer = new ResizeObserver(sync);
    observer.observe(bodyScroll);
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [result.columns, syncLayout]);

  const syncHeaderScroll = useCallback((el: HTMLElement) => {
    if (headerRef.current) {
      headerRef.current.scrollLeft = el.scrollLeft;
    }
  }, []);

  return (
    <div className="tool-season-columns tool-weekly-calendar-columns">
      <div ref={headerRef} className="tool-chart-pinned-header tool-season-header-wrap">
        <div className="tool-season-header-row">
          {result.columns.map((col) => (
            <div key={col.key} className="tool-season-column">
              <div className="tool-season-col-head">
                <div className="tool-season-col-title">{col.label}</div>
                <div className="tool-season-col-avg tool-weekly-col-count">
                  {col.shows.length} show{col.shows.length === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          ))}
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
          {result.columns.map((col) => (
            <div
              key={col.key}
              className="tool-season-column"
              data-scroll-anchor={col.label}
            >
              {col.shows.map((show) => {
                const { primary, episodesLeft, secondary } = formatWeeklyCalendarDetailLines(
                  show,
                  timeZone,
                );
                const songCount = showThemeSongs ? themeSongCounts.get(show.id) : undefined;
                const playlistStatus =
                  showThemeSongs && songCount
                    ? aggregatePlaylistMatchForRows(
                        themeSongCache.get(show.id)?.rows ?? [],
                        playlistCache,
                      )
                    : null;
                return (
                  <div key={show.id} className="tool-season-cell tool-weekly-cell">
                    <div className="tool-season-cell-grid tool-weekly-cell-grid">
                      <span
                        className={[
                          'tool-season-score',
                          'tool-weekly-score',
                          scoreDisplayToneClass(show.score),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {formatSeasonalScoreLabel(show.score, show.listStatus)}
                      </span>
                      <WeeklyCalendarPosterButton
                        mediaId={show.id}
                        title={show.title}
                        coverImage={show.coverImage}
                        onOpenMedia={onOpenMedia}
                      />
                      <div className="tool-weekly-title-block">
                        <div className="tool-weekly-title-block-content">
                          <div className="tool-weekly-title-row">
                            <ToolShowButton
                              mediaId={show.id}
                              title={show.title}
                              coverImage={show.coverImage}
                              onOpenMedia={onOpenMedia}
                              hideAvatar
                              className="tool-season-title tool-weekly-title"
                            />
                          </div>
                          {primary ? (
                            <div className="tool-weekly-detail tool-weekly-detail-time">{primary}</div>
                          ) : null}
                          {episodesLeft ? (
                            <div className="tool-weekly-detail tool-weekly-detail-time">{episodesLeft}</div>
                          ) : null}
                          {secondary ? (
                            <div className="tool-weekly-detail tool-weekly-detail-time">
                              {secondary}
                            </div>
                          ) : null}
                        </div>
                        {songCount ? (
                          <span
                            className={[
                              'tool-weekly-theme-song-badge',
                              playlistStatus ? `is-${playlistStatus}` : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            title={themeSongBadgeTitle(songCount, playlistStatus)}
                          >
                            🎵 {songCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </DragScroll>
    </div>
  );
}

export function WeeklyCalendarPanel({ onOpenMedia, dbSyncRevision }: ToolPanelProps) {
  const playlistCache = useSpotifyPlaylistCache();
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    onAfterRefresh: bustWeeklyCalendarUserListMemo,
  });
  const [form, setForm] = useState<WeeklyCalendarForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawEntries, setRawEntries] = useState<WeeklyCalendarRawEntry[] | null>(null);
  const [seasonLabel, setSeasonLabel] = useState<string | null>(null);
  const [themeSongCache, setThemeSongCache] = useState<Map<number, MediaThemeSongsPayload>>(
    () => new Map(),
  );
  const [refreshingThemeSongsCached, setRefreshingThemeSongsCached] = useState(false);
  const [refreshingThemeSongsPending, setRefreshingThemeSongsPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chartSessionRef = useRef(0);
  const fetchedUsernameRef = useRef<string | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  const patchForm = useCallback((patch: Partial<WeeklyCalendarForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const timeZone = weeklyCalendarTimezoneToIana(form.timezone);

  const customSeasonYearOptions = useMemo(() => buildWeeklyCalendarCustomSeasonYearOptions(), []);

  const seasonSegments = useMemo(() => {
    const now = new Date();
    const current = getCurrentAnilistSeason(now);
    const next = getNextAnilistSeason(current);
    return [
      { value: 'watching' as const, label: 'User List' },
      { value: 'current' as const, label: formatAnilistSeasonLabel(current) },
      { value: 'next' as const, label: formatAnilistSeasonLabel(next) },
      { value: 'custom' as const, label: 'Custom' },
    ];
  }, []);

  const currentSeasonLabel = seasonSegments.find((opt) => opt.value === 'current')?.label ?? '';

  const activeCustomSeasonRange = useMemo(
    () =>
      normalizeCustomSeasonRange(
        form.customSeasonMinEncoded,
        form.customSeasonMaxEncoded,
        customSeasonYearOptions,
      ),
    [form.customSeasonMinEncoded, form.customSeasonMaxEncoded, customSeasonYearOptions],
  );

  const result = useMemo((): WeeklyCalendarResult | null => {
    if (!rawEntries) {
      return null;
    }
    const handle = form.username.trim().toLowerCase();
    if (fetchedUsernameRef.current !== null && handle !== fetchedUsernameRef.current) {
      return null;
    }
    return finalizeWeeklyCalendarResult(rawEntries, form, seasonLabel);
  }, [rawEntries, form, seasonLabel]);

  const themeSongCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const [mediaId, payload] of themeSongCache) {
      if (payload.rows.length > 0) {
        counts.set(mediaId, payload.rows.length);
      }
    }
    return counts;
  }, [themeSongCache]);

  const chartShows = useMemo(() => {
    if (result?.kind !== 'columns') {
      return [];
    }
    return collectWeeklyCalendarShows(result);
  }, [result]);

  useEffect(() => {
    if (!form.showThemeSongs || result?.kind !== 'columns') {
      setThemeSongCache(new Map());
      return;
    }
    const mediaIds = collectWeeklyCalendarMediaIds(result);
    let cancelled = false;
    void productionReads.getMediaThemeSongsExpansionsBatch(mediaIds).then((cache) => {
      if (!cancelled) {
        setThemeSongCache(cache);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [form.showThemeSongs, result, dbSyncRevision]);

  const onRefreshThemeSongs = useCallback(
    (mediaIds: number[], kind: 'cached' | 'pending') => {
      if (mediaIds.length === 0) {
        return;
      }
      const setRefreshing =
        kind === 'cached' ? setRefreshingThemeSongsCached : setRefreshingThemeSongsPending;
      void (async () => {
        setRefreshing(true);
        try {
          for (const mediaId of mediaIds) {
            await runAnilistMediaThemeSongsExpansion(mediaId, undefined, { force: true });
            const expansion = await productionReads.getMediaThemeSongsExpansion(mediaId);
            if (expansion) {
              setThemeSongCache((prev) => {
                const next = new Map(prev);
                next.set(mediaId, expansion.payload);
                return next;
              });
            }
          }
        } finally {
          setRefreshing(false);
        }
      })();
    },
    [],
  );

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const onRun = useCallback(
    async (forceRefresh = false) => {
      const username = form.username.trim();
      if (!username) {
        setError('Enter an AniList username.');
        setRawEntries(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const handle = username.toLowerCase();

      setRunning(true);
      setError(null);
      setRawEntries(null);
      setSeasonLabel(null);

      try {
        const seasonSpecs = resolveWeeklyCalendarSeasonSpecs(form);
        if (seasonSpecs) {
          const { entries, seasonLabel: label } = await fetchWeeklyCalendarSeasonsEntries(
            username,
            seasonSpecs,
            controller.signal,
            forceRefresh ? { forceRefresh: true } : undefined,
          );
          setRawEntries(entries);
          setSeasonLabel(label);
        } else {
          const entries = await fetchWeeklyCalendarWatchingEntries(
            username,
            controller.signal,
            forceRefresh ? { forceRefresh: true } : undefined,
          );
          setRawEntries(entries);
          setSeasonLabel(null);
        }
        fetchedUsernameRef.current = handle;
        chartSessionRef.current += 1;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to load calendar.');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [form.customSeasonMaxEncoded, form.customSeasonMinEncoded, form.seasonScope, form.username],
  );

  useEffect(() => {
    const handle = form.username.trim().toLowerCase();
    if (
      rawEntries != null &&
      fetchedUsernameRef.current !== null &&
      handle !== fetchedUsernameRef.current
    ) {
      setRawEntries(null);
      fetchedUsernameRef.current = null;
    }
  }, [form.username, rawEntries]);

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Chart airing and upcoming shows from a user&apos;s watching list by weekday — or browse a season ({currentSeasonLabel}).
        <br />
        Enable <strong>NOT ON LIST</strong> in the list status filter to show all shows from those seasons.
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
        <div className="tool-weekly-filters">
          <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-weekly-primary-filters">
            <ToolUsernameField
              label="AniList username"
              value={form.username}
              disabled={running}
              refreshing={refreshingList}
              onChange={(username) => patchForm({ username })}
              onRefresh={() => refreshUsernameList(form.username, running)}
            />

            <div
              className="tool-field tool-field-label-row tool-weekly-season-scope"
              role="group"
              aria-labelledby="weekly-calendar-season-label"
            >
              <span className="tool-field-label" id="weekly-calendar-season-label">
                Season
              </span>
              <div className="tool-segmented tool-weekly-season-segmented">
                {seasonSegments.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={form.seasonScope === opt.value ? 'active' : ''}
                    aria-pressed={form.seasonScope === opt.value}
                    disabled={running}
                    onClick={() => {
                      if (opt.value === 'custom') {
                        const range = normalizeCustomSeasonRange(
                          form.customSeasonMinEncoded,
                          form.customSeasonMaxEncoded,
                          customSeasonYearOptions,
                        );
                        patchForm({
                          seasonScope: 'custom',
                          customSeasonMinEncoded: range.minEncoded,
                          customSeasonMaxEncoded: range.maxEncoded,
                        });
                        return;
                      }
                      patchForm({ seasonScope: opt.value });
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {form.seasonScope === 'custom' ? (
              <WeeklyCalendarCustomSeasonChip
                options={customSeasonYearOptions}
                minEncoded={activeCustomSeasonRange.minEncoded}
                maxEncoded={activeCustomSeasonRange.maxEncoded}
                onChange={(patch) => {
                  const range = normalizeCustomSeasonRange(
                    patch.customSeasonMinEncoded,
                    patch.customSeasonMaxEncoded,
                    customSeasonYearOptions,
                  );
                  patchForm({
                    customSeasonMinEncoded: range.minEncoded,
                    customSeasonMaxEncoded: range.maxEncoded,
                  });
                }}
              />
            ) : null}

            <MultiSelectChip<WeeklyCalendarListStatusFilter>
              label="list status"
              options={[...WEEKLY_CALENDAR_LIST_STATUS_OPTIONS]}
              selected={form.listStatusFilters}
              formatOption={formatWeeklyCalendarListStatusFilterLabel}
              onToggle={(status) =>
                patchForm({
                  listStatusFilters: toggleInArray(form.listStatusFilters, status),
                })
              }
            />

            <MultiSelectChip<WeeklyCalendarMediaStatusFilter>
              label="airing status"
              options={[...WEEKLY_CALENDAR_MEDIA_STATUS_OPTIONS]}
              selected={form.mediaStatusFilters}
              formatOption={formatWeeklyCalendarMediaStatusFilterLabel}
              onToggle={(status) =>
                patchForm({
                  mediaStatusFilters: toggleInArray(form.mediaStatusFilters, status),
                })
              }
            />
          </div>

          <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-weekly-primary-filters">
            <label className="tool-field tool-field-label-row tool-weekly-week-start">
              <span className="tool-field-label">Week starts on</span>
              <div className="tool-weekly-week-start-field">
                <select
                  className="settings-spotify-select"
                  disabled={running}
                  value={form.weekStartDay}
                  onChange={(e) =>
                    patchForm({ weekStartDay: e.target.value as WeeklyCalendarWeekStartDay })
                  }
                >
                  {WEEK_START_OPTIONS.map((day) => (
                    <option key={day} value={day}>
                      {day[0] + day.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            </label>

            <div
              className="tool-field tool-field-label-row tool-weekly-timezone"
              role="group"
              aria-labelledby="weekly-calendar-tz-label"
            >
              <span className="tool-field-label" id="weekly-calendar-tz-label">
                Time zone
              </span>
              <div className="tool-segmented">
                {TIMEZONE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={form.timezone === opt.value ? 'active' : ''}
                    aria-pressed={form.timezone === opt.value}
                    disabled={running}
                    onClick={() => patchForm({ timezone: opt.value })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="tool-checkbox">
              <input
                type="checkbox"
                checked={form.showUnscheduledColumn}
                disabled={running}
                onChange={(e) => patchForm({ showUnscheduledColumn: e.target.checked })}
              />
              Unknown Airing Day column
            </label>

            <label className="tool-checkbox">
              <input
                type="checkbox"
                checked={form.showThemeSongs}
                disabled={running}
                onChange={(e) => patchForm({ showThemeSongs: e.target.checked })}
              />
              Show theme songs
            </label>
          </div>
        </div>

        <div className="tool-actions">
          <ToolRunButton label="Load calendar" running={running} onRun={onRun} />
          {running ? (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      {error ? <p className="tool-error">{error}</p> : null}

      {result?.kind === 'empty' ? <p className="tool-muted">{result.message}</p> : null}

      {result?.kind === 'columns' ? (
        <>
          <div className="tool-chart-fullbleed tool-season-fullbleed" key={chartSessionRef.current}>
            {result.seasonLabel ? (
              <p className="tool-muted tool-weekly-season-banner">{result.seasonLabel}</p>
            ) : null}
            <WeeklyCalendarColumnsView
              result={result}
              timeZone={timeZone}
              showThemeSongs={form.showThemeSongs}
              themeSongCounts={themeSongCounts}
              themeSongCache={themeSongCache}
              playlistCache={playlistCache}
              onOpenMedia={onOpenMedia}
            />
          </div>
          {form.showThemeSongs ? (
            <WeeklyCalendarThemeSongsPanel
              shows={chartShows}
              themeSongCache={themeSongCache}
              playlistCache={playlistCache}
              onOpenMedia={onOpenMedia}
              onRefreshThemeSongs={onRefreshThemeSongs}
              refreshingCached={refreshingThemeSongsCached}
              refreshingPending={refreshingThemeSongsPending}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
