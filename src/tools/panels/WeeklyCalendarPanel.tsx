import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { MultiSelectChip, toggleInArray } from '../../lib/importers/anilist/filters';
import { ToolShowButton, ToolEntityAvatar } from '../toolEntityLinks';
import {
  anilistUrlForMediaEntry,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { DragScroll } from '../../components/DragScroll';
import { applyHeaderScrollbarGutter } from '../../lib/chartSplitTableSync';
import {
  bustWeeklyCalendarSessionMemo,
  fetchWeeklyCalendarSeasonEntries,
  fetchWeeklyCalendarWatchingEntries,
} from './weeklyCalendarApi';
import {
  DEFAULT_WEEKLY_CALENDAR_FORM,
  finalizeWeeklyCalendarResult,
  formatAnilistSeasonLabel,
  formatWeeklyCalendarDetailLines,
  formatWeeklyCalendarListStatusFilterLabel,
  getCurrentAnilistSeason,
  getNextAnilistSeason,
  isWeeklyCalendarSeasonScope,
  normalizeWeeklyCalendarListStatusFilters,
  weeklyCalendarTimezoneToIana,
  WEEKLY_CALENDAR_LIST_STATUS_OPTIONS,
  type WeeklyCalendarForm,
  type WeeklyCalendarListStatusFilter,
  type WeeklyCalendarRawEntry,
  type WeeklyCalendarResult,
  type WeeklyCalendarSeasonScope,
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
  | 'seasonScope'
  | 'listStatusFilters'
  | 'showUnscheduledColumn'
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
      const parsed = JSON.parse(raw) as Partial<PersistedWeeklyCalendarForm> & {
        showCurrentSeasonAiring?: boolean;
      };
      const seasonScope: WeeklyCalendarSeasonScope =
        parsed.seasonScope === 'current' ||
        parsed.seasonScope === 'next' ||
        parsed.seasonScope === 'watching'
          ? parsed.seasonScope
          : parsed.showCurrentSeasonAiring
            ? 'current'
            : DEFAULT_WEEKLY_CALENDAR_FORM.seasonScope;
      return {
        ...DEFAULT_WEEKLY_CALENDAR_FORM,
        username: withLastAnilistUsername(parsed.username ?? ''),
        weekStartDay:
          parsed.weekStartDay && WEEK_START_OPTIONS.includes(parsed.weekStartDay)
            ? parsed.weekStartDay
            : DEFAULT_WEEKLY_CALENDAR_FORM.weekStartDay,
        timezone:
          parsed.timezone && TIMEZONE_OPTIONS.some((opt) => opt.value === parsed.timezone)
            ? parsed.timezone
            : DEFAULT_WEEKLY_CALENDAR_FORM.timezone,
        seasonScope,
        listStatusFilters: normalizeWeeklyCalendarListStatusFilters(parsed.listStatusFilters),
        showUnscheduledColumn: parsed.showUnscheduledColumn ?? false,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_WEEKLY_CALENDAR_FORM, username: withLastAnilistUsername('') };
}

function saveForm(form: WeeklyCalendarForm): void {
  try {
    const persisted: PersistedWeeklyCalendarForm = {
      username: form.username,
      weekStartDay: form.weekStartDay,
      timezone: form.timezone,
      seasonScope: form.seasonScope,
      listStatusFilters: form.listStatusFilters,
      showUnscheduledColumn: form.showUnscheduledColumn,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
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

function WeeklyCalendarColumnsView({
  result,
  timeZone,
  onOpenMedia,
}: {
  result: Extract<WeeklyCalendarResult, { kind: 'columns' }>;
  timeZone: string | undefined;
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
                        <ToolShowButton
                          mediaId={show.id}
                          title={show.title}
                          coverImage={show.coverImage}
                          onOpenMedia={onOpenMedia}
                          hideAvatar
                          className="tool-season-title tool-weekly-title"
                        />
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

export function WeeklyCalendarPanel({ onOpenMedia }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    onAfterRefresh: bustWeeklyCalendarSessionMemo,
  });
  const [form, setForm] = useState<WeeklyCalendarForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawEntries, setRawEntries] = useState<WeeklyCalendarRawEntry[] | null>(null);
  const [seasonLabel, setSeasonLabel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chartSessionRef = useRef(0);
  const fetchedUsernameRef = useRef<string | null>(null);
  const fetchedSeasonScopeRef = useRef<WeeklyCalendarSeasonScope | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  const patchForm = useCallback((patch: Partial<WeeklyCalendarForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const timeZone = weeklyCalendarTimezoneToIana(form.timezone);

  const result = useMemo((): WeeklyCalendarResult | null => {
    if (!rawEntries) {
      return null;
    }
    const handle = form.username.trim().toLowerCase();
    if (fetchedUsernameRef.current !== null && handle !== fetchedUsernameRef.current) {
      return null;
    }
    if (
      fetchedSeasonScopeRef.current !== null &&
      form.seasonScope !== fetchedSeasonScopeRef.current
    ) {
      return null;
    }
    return finalizeWeeklyCalendarResult(rawEntries, form, seasonLabel);
  }, [rawEntries, form, seasonLabel]);

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
        if (isWeeklyCalendarSeasonScope(form.seasonScope)) {
          const seasonScope = form.seasonScope;
          const { entries, seasonLabel: label } = await fetchWeeklyCalendarSeasonEntries(
            username,
            seasonScope,
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
        fetchedSeasonScopeRef.current = form.seasonScope;
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
    [form.seasonScope, form.username],
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
      fetchedSeasonScopeRef.current = null;
    }
  }, [form.username, rawEntries]);

  const seasonOptions = useMemo(() => {
    const now = new Date();
    const current = getCurrentAnilistSeason(now);
    const next = getNextAnilistSeason(current);
    return [
      { value: 'watching' as const, label: 'User List' },
      { value: 'current' as const, label: formatAnilistSeasonLabel(current) },
      { value: 'next' as const, label: formatAnilistSeasonLabel(next) },
    ];
  }, []);

  const currentSeasonLabel = seasonOptions.find((opt) => opt.value === 'current')?.label ?? '';

  const prevSeasonScopeRef = useRef(form.seasonScope);
  useEffect(() => {
    const prev = prevSeasonScopeRef.current;
    prevSeasonScopeRef.current = form.seasonScope;
    if (
      prev === form.seasonScope ||
      rawEntries == null ||
      running ||
      !form.username.trim()
    ) {
      return;
    }
    void onRun(false);
  }, [form.seasonScope, form.username, onRun, rawEntries, running]);

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Chart airing and upcoming shows from a user&apos;s watching list by weekday — or browse
        a season ({currentSeasonLabel}).
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

            <label className="tool-field tool-field-label-row tool-weekly-season-scope">
              <span className="tool-field-label">Season</span>
              <select
                className="tool-select"
                disabled={running}
                value={form.seasonScope}
                onChange={(e) =>
                  patchForm({ seasonScope: e.target.value as WeeklyCalendarSeasonScope })
                }
              >
                {seasonOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

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
          </div>

          <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-weekly-primary-filters">
            <label className="tool-field tool-field-label-row tool-weekly-week-start">
              <span className="tool-field-label">Week starts on</span>
              <select
                className="tool-select"
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
              Unknown Airing Day Column
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
        <div className="tool-chart-fullbleed tool-season-fullbleed" key={chartSessionRef.current}>
          {result.seasonLabel ? (
            <p className="tool-muted tool-weekly-season-banner">{result.seasonLabel}</p>
          ) : null}
          <WeeklyCalendarColumnsView result={result} timeZone={timeZone} onOpenMedia={onOpenMedia} />
        </div>
      ) : null}
    </section>
  );
}
