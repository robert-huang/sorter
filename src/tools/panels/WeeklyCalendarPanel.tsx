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
import {
  DEFAULT_WEEKLY_CALENDAR_FORM,
  buildWeeklyCalendarCustomSeasonYearOptions,
  decodeAnilistSeasonEncoded,
  defaultWeeklyCalendarCustomSeasonRange,
  finalizeWeeklyCalendarResult,
  formatAnilistSeasonLabel,
  formatWeeklyCalendarDetailLines,
  formatWeeklyCalendarListStatusFilterLabel,
  getCurrentAnilistSeason,
  getNextAnilistSeason,
  normalizeCustomSeasonRange,
  resolveWeeklyCalendarSeasonSpecs,
  weeklyCalendarTimezoneToIana,
  WEEKLY_CALENDAR_LIST_STATUS_OPTIONS,
  type WeeklyCalendarForm,
  type WeeklyCalendarListStatusFilter,
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
  'username' | 'weekStartDay' | 'timezone' | 'showUnscheduledColumn'
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
        showUnscheduledColumn: parsed.showUnscheduledColumn ?? false,
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
      showUnscheduledColumn: form.showUnscheduledColumn,
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
    onAfterRefresh: bustWeeklyCalendarUserListMemo,
  });
  const [form, setForm] = useState<WeeklyCalendarForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawEntries, setRawEntries] = useState<WeeklyCalendarRawEntry[] | null>(null);
  const [seasonLabel, setSeasonLabel] = useState<string | null>(null);
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
