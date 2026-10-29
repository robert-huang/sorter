import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DragScroll } from '../../components/DragScroll';
import { CircularArrowGlyph } from '../../components/CircularArrowGlyph';
import { RemoveGlyph } from '../../components/RemoveGlyph';
import {
  ALL_LIST_STATUSES,
  ANILIST_INITIAL_CHIP_STATE,
  AnilistChips,
  MultiSelectChip,
  ScoreRangeChip,
  computeAllowedMediaIds,
  isInitialState,
  toggleInArray,
  type AnilistFilterChipState,
} from '../../lib/importers/anilist/filters';
import { pickMediaTitle } from '../../lib/importers/anilist/mediaDisplayLabel';
import { useClickOutside } from '../../lib/hooks/useClickOutside';
import { useFloatingMenuStyle } from '../../lib/hooks/useFloatingMenuStyle';
import { useToolsPreferences } from '../../hooks/useToolsPreferences';
import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import { ToolAnimeMangaMediaTypeFilter } from '../ToolSegmentedFilter';
import { ToolShowButton } from '../toolEntityLinks';
import type { ToolPanelProps } from '../toolTypes';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { loadComparisonList, type LoadedComparisonList } from './scoreComparisonApi';
import {
  COMPARISON_STAT_OPTIONS,
  DEFAULT_COMPARISON_SORT,
  RAW_NORMALIZATION,
  baseStat,
  buildComparisonRows,
  cellValue,
  isNormalizedStat,
  formatComparisonValue,
  loadScoreComparisonSettings,
  nextComparisonSort,
  rowStat,
  saveScoreComparisonSettings,
  sortComparisonRows,
  statusesForUser,
  userColumnSummaries,
  userKey,
  userSortColumn,
  userWholeListStats,
  visibleComparisonRows,
  type ComparisonCell,
  type ComparisonFilters,
  type ComparisonMedia,
  type ComparisonMediaType,
  type ComparisonNormalization,
  type ComparisonRow,
  type ComparisonSortColumn,
  type ComparisonStat,
  type ComparisonStatOption,
  type ComparisonUserList,
  type ScoreComparisonSettings,
  type SortContext,
  type UserListStats,
} from './scoreComparisonLogic';
import { listStatusScoreLabel, scoreDisplayToneClass } from './seasonalScoresLogic';

type ListLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; list: LoadedComparisonList }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const STAT_LABELS: Record<ComparisonStat, string> = {
  mean: 'Mean',
  stddev: 'Standard Deviation',
};

const STAT_OPTION_LABELS: Record<ComparisonStatOption, string> = {
  mean: 'Mean',
  stddev: 'Standard Deviation',
  normalizedMean: 'Normalized Mean',
  normalizedStddev: 'Normalized Standard Deviation',
};

function loadKey(username: string, mediaType: ComparisonMediaType): string {
  return `${mediaType}:${userKey(username)}`;
}

/** Loads lists on demand (cached unless refreshed), keyed by media type + user. */
function useComparisonLists() {
  const [states, setStates] = useState<Record<string, ListLoadState>>({});

  const load = useCallback(
    (username: string, mediaType: ComparisonMediaType, forceRefresh: boolean) => {
      const key = loadKey(username, mediaType);
      setStates((prev) => ({ ...prev, [key]: { kind: 'loading' } }));
      void loadComparisonList(username, mediaType, { forceRefresh })
        .then((list) => {
          setStates((prev) => ({
            ...prev,
            [key]: list ? { kind: 'ready', list } : { kind: 'missing' },
          }));
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          setStates((prev) => ({ ...prev, [key]: { kind: 'error', message } }));
        });
    },
    [],
  );

  const stateFor = (username: string, mediaType: ComparisonMediaType): ListLoadState =>
    states[loadKey(username, mediaType)] ?? { kind: 'loading' };

  const isLoading = (username: string, mediaType: ComparisonMediaType): boolean =>
    states[loadKey(username, mediaType)]?.kind === 'loading';

  return { stateFor, isLoading, load };
}

/** Media-level AniList chips (genre, tag, …) over the union of every list. */
function useAllowedMediaIds(
  mediaIds: readonly number[],
  chipState: AnilistFilterChipState,
): ReadonlySet<number> | null {
  const [allowed, setAllowed] = useState<ReadonlySet<number> | null>(null);
  const idsKey = mediaIds.join(',');
  const chipKey = JSON.stringify(chipState);
  useEffect(() => {
    const mediaOnly: AnilistFilterChipState = {
      ...chipState,
      listStatuses: ALL_LIST_STATUSES,
      userScoreInclude: 'any',
      scoreMin: null,
      scoreMax: null,
    };
    if (isInitialState(mediaOnly)) {
      setAllowed(null);
      return;
    }
    let cancelled = false;
    void computeAllowedMediaIds(mediaIds, mediaOnly).then((next) => {
      if (!cancelled) setAllowed(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, chipKey]);
  return allowed;
}

function UsernameChipsInput({
  usernames,
  isLoading,
  onAdd,
  onRemove,
  onRefresh,
}: {
  usernames: readonly string[];
  isLoading: (username: string) => boolean;
  onAdd: (username: string) => void;
  onRemove: (username: string) => void;
  onRefresh: (username: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    const handle = text.trim();
    if (!handle) return;
    onAdd(handle);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="tool-field tool-field-label-row tool-score-compare-users">
      <span className="tool-field-label">Users</span>
      <div className="tool-score-compare-user-chips">
        {usernames.map((name) => (
          <span key={userKey(name)} className="tool-score-compare-user-chip">
            {name}
            <button
              type="button"
              className="btn icon-only tool-score-compare-refresh"
              disabled={isLoading(name)}
              onClick={() => onRefresh(name)}
              title={`Refresh ${name}'s list from AniList`}
              aria-label={`Refresh ${name}'s list from AniList`}
            >
              <CircularArrowGlyph />
            </button>
            <button
              type="button"
              className="tool-score-compare-user-chip-remove"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={() => onRemove(name)}
            >
              <RemoveGlyph size={10} />
            </button>
          </span>
        ))}
        <input
          className="slot-search tool-username-input"
          type="text"
          name="score-compare-username"
          aria-label="AniList username to compare"
          placeholder="AL Username"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="one-time-code"
          data-1p-ignore
          data-lpignore="true"
        />
        <button type="button" className="btn small" disabled={!text.trim()} onClick={submit}>
          Add
        </button>
      </div>
    </div>
  );
}

function sortIndicator(sort: ScoreComparisonSettings['sort'], column: ComparisonSortColumn) {
  if (sort.column !== column) return null;
  return (
    <span className="tool-chart-sort-indicator" aria-hidden="true">
      {sort.direction === 'desc' ? '↓' : '↑'}
    </span>
  );
}

function UserColumnHeader({
  username,
  state,
  statuses,
  sort,
  onSort,
  onStatusesChange,
}: {
  username: string;
  state: ListLoadState;
  statuses: readonly AnilistMediaListStatus[];
  sort: ScoreComparisonSettings['sort'];
  onSort: () => void;
  onStatusesChange: (statuses: AnilistMediaListStatus[]) => void;
}) {
  const column = userSortColumn(username);
  const label = state.kind === 'ready' ? state.list.name : username;
  return (
    <th className="tool-score-compare-user-th">
      <div className="tool-score-compare-user-head">
        <button type="button" className="tool-chart-sort-th tool-score-compare-sort-btn" onClick={onSort}>
          {label}
          {sortIndicator(sort, column)}
        </button>
        <MultiSelectChip<AnilistMediaListStatus>
          label={`${label} list statuses`}
          labelHint={`List statuses shown for ${label}`}
          triggerLabel={
            statuses.length === 0 || statuses.length >= ALL_LIST_STATUSES.length
              ? 'all'
              : String(statuses.length)
          }
          options={ALL_LIST_STATUSES}
          selected={[...statuses]}
          onToggle={(status) => onStatusesChange(toggleInArray([...statuses], status))}
          onReplaceAll={(values) => onStatusesChange([...values])}
          floatingMenu
        />
      </div>
      {state.kind === 'loading' && <span className="tool-field-hint">Loading…</span>}
      {state.kind === 'missing' && <span className="tool-error">User not found</span>}
      {state.kind === 'error' && <span className="tool-error">{state.message}</span>}
    </th>
  );
}

/** Left click sorts; right click (or the ▾ caret, for touch) picks the stat. */
function StatColumnHeader({
  stat,
  sort,
  onSort,
  onStatChange,
}: {
  stat: ComparisonStatOption;
  sort: ScoreComparisonSettings['sort'];
  onSort: () => void;
  onStatChange: (stat: ComparisonStatOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const menuStyle = useFloatingMenuStyle(true, open, rootRef, menuRef);
  const menuTitle = 'Right-click to change the stat';
  return (
    <th className="tool-score-compare-stat-th">
      <div
        ref={rootRef}
        className="tool-score-compare-stat-head"
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        <button
          type="button"
          className="tool-chart-sort-th tool-score-compare-sort-btn"
          title={menuTitle}
          onClick={onSort}
        >
          {STAT_OPTION_LABELS[stat]}
          {sortIndicator(sort, 'stat')}
        </button>
        <button
          type="button"
          className="tool-score-compare-stat-caret"
          aria-label="Change stat"
          aria-haspopup="menu"
          aria-expanded={open}
          title={menuTitle}
          onClick={() => setOpen((x) => !x)}
        >
          ▾
        </button>
        {open && (
          <div
            ref={menuRef}
            className="filter-chip-menu tool-score-compare-stat-menu"
            style={menuStyle}
            role="menu"
          >
            {COMPARISON_STAT_OPTIONS.map((option) => (
              <label key={option} className="filter-chip-option">
                <input
                  type="radio"
                  name="score-compare-stat"
                  checked={stat === option}
                  onChange={() => {
                    onStatChange(option);
                    setOpen(false);
                  }}
                />
                <span className="filter-chip-option-text">{STAT_OPTION_LABELS[option]}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </th>
  );
}

function ScoreCell({
  cell,
  stats,
  normalization,
  showAllRows,
  mediaType,
}: {
  cell: ComparisonCell;
  stats: UserListStats | null;
  normalization: ComparisonNormalization;
  showAllRows: boolean;
  mediaType: ComparisonMediaType;
}) {
  if (!cell.entry || (cell.excluded && !showAllRows)) {
    return <td className="tool-score-compare-cell" />;
  }
  const value = cellValue(cell, stats, normalization);
  const text =
    value === null
      ? (listStatusScoreLabel(cell.entry.status, cell.entry.score, mediaType) ?? '–')
      : formatComparisonValue(value, normalization);
  const className = [
    'tool-score-compare-cell',
    normalization.kind === 'raw' ? scoreDisplayToneClass(cell.entry.score || null) : '',
    cell.excluded ? 'tool-score-compare-cell--excluded' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <td className={className} title={cell.entry.status}>
      {text}
      {cell.favourite && (
        <span className="tool-score-compare-fav" title="Favourite" aria-label="Favourite">
          ♥
        </span>
      )}
    </td>
  );
}

function ComparisonTable({
  usernames,
  states,
  rows,
  summaries,
  passingCount,
  totalCount,
  settings,
  mediaType,
  ctx,
  onSort,
  onStatusesChange,
  onStatChange,
  onOpenMedia,
}: {
  usernames: readonly string[];
  states: readonly ListLoadState[];
  rows: readonly ComparisonRow[];
  summaries: readonly (UserListStats | null)[];
  passingCount: number;
  totalCount: number;
  settings: ScoreComparisonSettings;
  mediaType: ComparisonMediaType;
  ctx: SortContext;
  onSort: (column: ComparisonSortColumn) => void;
  onStatusesChange: (username: string, statuses: AnilistMediaListStatus[]) => void;
  onStatChange: (stat: ComparisonStatOption) => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const { sort, showAllRows } = settings;
  const { normalization, stat } = ctx;
  return (
    <div className="tool-results tool-score-compare-outer">
    <DragScroll className="tool-score-compare-scroll">
      <table className="tool-score-compare-table">
        <thead>
          <tr>
            <th className="tool-score-compare-title-th">
              <button type="button" className="tool-chart-sort-th tool-score-compare-sort-btn" onClick={() => onSort('title')}>
                Title
                {sortIndicator(sort, 'title')}
              </button>
            </th>
            <StatColumnHeader
              stat={settings.stat}
              sort={sort}
              onSort={() => onSort('stat')}
              onStatChange={onStatChange}
            />
            {usernames.map((name, index) => (
              <UserColumnHeader
                key={userKey(name)}
                username={name}
                state={states[index]!}
                statuses={statusesForUser(settings.filters, name)}
                sort={sort}
                onSort={() => onSort(userSortColumn(name))}
                onStatusesChange={(next) => onStatusesChange(name, next)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.media.id} className={row.passes ? undefined : 'tool-score-compare-row--failing'}>
              <td className="tool-score-compare-title">
                <ToolShowButton
                  mediaId={row.media.id}
                  title={row.media.title}
                  coverImage={row.media.coverImage}
                  mediaType={mediaType}
                  onOpenMedia={onOpenMedia}
                  compact
                />
              </td>
              <td className="tool-score-compare-cell tool-score-compare-stat">
                {formatComparisonValue(rowStat(row, stat, ctx.userStats, normalization), normalization)}
              </td>
              {row.cells.map((cell, index) => (
                <ScoreCell
                  key={usernames[index]}
                  cell={cell}
                  stats={ctx.userStats[index] ?? null}
                  normalization={normalization}
                  showAllRows={showAllRows}
                  mediaType={mediaType}
                />
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          {(['mean', 'stddev'] as const).map((summaryStat) => (
            <tr key={summaryStat}>
              <th scope="row" className="tool-score-compare-title">{STAT_LABELS[summaryStat]}</th>
              <td className="tool-score-compare-cell tool-score-compare-stat" />
              {summaries.map((summary, index) => (
                <td key={usernames[index]} className="tool-score-compare-cell">
                  {summary
                    ? formatComparisonValue(
                        summaryStat === 'mean' ? summary.mean : summary.stdDev,
                        RAW_NORMALIZATION,
                      )
                    : ''}
                </td>
              ))}
            </tr>
          ))}
        </tfoot>
      </table>
    </DragScroll>
    <div className="tool-score-compare-count">
      Showing {passingCount} of {totalCount}
    </div>
    </div>
  );
}

export function ScoreComparisonPanel({ onOpenMedia }: ToolPanelProps) {
  const [settings, setSettings] = useState<ScoreComparisonSettings>(loadScoreComparisonSettings);
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const { filters, showAllRows, sort } = settings;
  const { prefs } = useToolsPreferences();
  const stat = baseStat(settings.stat);
  const normalization: ComparisonNormalization = useMemo(() => {
    if (!isNormalizedStat(settings.stat)) return RAW_NORMALIZATION;
    if (!prefs.scoreComparisonRescale) return { kind: 'z' };
    return {
      kind: 'rescaled',
      mean: prefs.scoreComparisonTargetMean,
      stdDev: prefs.scoreComparisonTargetStdDev,
    };
  }, [
    settings.stat,
    prefs.scoreComparisonRescale,
    prefs.scoreComparisonTargetMean,
    prefs.scoreComparisonTargetStdDev,
  ]);
  const { stateFor, isLoading, load } = useComparisonLists();
  // Snapshot taken by Compare; nothing loads until the first click.
  const [compared, setCompared] = useState<{
    usernames: readonly string[];
    mediaType: ComparisonMediaType;
  } | null>(null);
  const mediaType = compared?.mediaType ?? settings.mediaType;
  // Removing a user drops their column right away; additions wait for Compare.
  const usernames = useMemo(
    () =>
      (compared?.usernames ?? []).filter((name) =>
        settings.usernames.some((current) => userKey(current) === userKey(name)),
      ),
    [compared, settings.usernames],
  );
  const compare = () => {
    for (const name of settings.usernames) load(name, settings.mediaType, false);
    setCompared({ usernames: settings.usernames, mediaType: settings.mediaType });
    setSettings((prev) => ({ ...prev, stat: 'mean', sort: DEFAULT_COMPARISON_SORT }));
  };
  const refresh = (name: string) => load(name, settings.mediaType, true);

  useEffect(() => {
    saveScoreComparisonSettings(settings);
  }, [settings]);

  const patch = useCallback((next: Partial<ScoreComparisonSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
  }, []);
  const patchFilters = useCallback((next: Partial<ComparisonFilters>) => {
    setSettings((prev) => ({ ...prev, filters: { ...prev.filters, ...next } }));
  }, []);

  const chipState: AnilistFilterChipState = useMemo(
    () => ({ ...ANILIST_INITIAL_CHIP_STATE, ...(settings.chipState ?? {}) }),
    [settings.chipState],
  );

  const states = usernames.map((name) => stateFor(name, mediaType));
  const readyLists = states.map((state) => (state.kind === 'ready' ? state.list : null));
  const readyKey = readyLists.map((list) => (list ? `${list.name}:${list.entries.size}` : '-')).join('|');

  const { users, mediaById, userStats } = useMemo(() => {
    const nextUsers: ComparisonUserList[] = [];
    const nextMedia = new Map<number, ComparisonMedia>();
    const nextStats: (UserListStats | null)[] = [];
    usernames.forEach((name, index) => {
      const list = readyLists[index];
      nextUsers.push({
        username: name,
        entries: list?.entries ?? new Map(),
        favouriteMediaIds: list?.favouriteMediaIds ?? new Set(),
      });
      nextStats.push(list ? userWholeListStats(list.entries.values()) : null);
      for (const media of list?.media ?? []) {
        if (!nextMedia.has(media.id)) {
          nextMedia.set(media.id, {
            id: media.id,
            title: pickMediaTitle(media),
            coverImage: media.cover_image,
          });
        }
      }
    });
    return { users: nextUsers, mediaById: nextMedia, userStats: nextStats };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey, usernames, displayLabelRevision]);

  const mediaIds = useMemo(() => [...mediaById.keys()].sort((a, b) => a - b), [mediaById]);
  const mediaIdSet = useMemo(() => new Set<number>(mediaIds), [mediaIds]);
  const allowedMediaIds = useAllowedMediaIds(mediaIds, chipState);

  const rows = useMemo(
    () => buildComparisonRows(users, mediaById, filters, allowedMediaIds),
    [users, mediaById, filters, allowedMediaIds],
  );
  const ctx: SortContext = useMemo(
    () => ({ usernames, userStats, normalization, stat }),
    [usernames, userStats, normalization, stat],
  );
  const displayRows = useMemo(
    () => sortComparisonRows(visibleComparisonRows(rows, showAllRows), sort, ctx),
    [rows, showAllRows, sort, ctx],
  );
  const summaries = useMemo(
    () => userColumnSummaries(rows, usernames.length),
    [rows, usernames.length],
  );
  const passingCount = rows.filter((row) => row.passes).length;

  const addUser = (name: string) => {
    if (settings.usernames.some((existing) => userKey(existing) === userKey(name))) return;
    patch({ usernames: [...settings.usernames, name] });
  };
  const removeUser = (name: string) => {
    const key = userKey(name);
    setSettings((prev) => ({
      ...prev,
      usernames: prev.usernames.filter((existing) => userKey(existing) !== key),
    }));
  };
  return (
    <section className="tool-panel tool-score-compare">
      <p className="tool-panel-lead">
        Compare AniList scores across users. Lists load from the local cache when available; use ↻
        in a column to refresh one user.
      </p>
      <div className="tool-form-card tool-score-compare-controls">
        <UsernameChipsInput
          usernames={settings.usernames}
          isLoading={(name) => isLoading(name, settings.mediaType)}
          onAdd={addUser}
          onRemove={removeUser}
          onRefresh={refresh}
        />
        <div className="tool-score-compare-options">
          <label className="tool-field tool-field-label-row tool-score-compare-min-lists-field">
            <span className="tool-field-label">Min Lists</span>
            <input
              className="slot-search tool-shared-credits-min-shared-input tool-score-compare-min-lists"
              type="number"
              min={0}
              step={1}
              value={filters.minLists ?? ''}
              placeholder="all"
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value.trim(), 10);
                patchFilters({ minLists: Number.isFinite(parsed) && parsed > 0 ? parsed : null });
              }}
            />
          </label>
          <ToolAnimeMangaMediaTypeFilter
            value={settings.mediaType}
            onChange={(next) => patch({ mediaType: next })}
          />
          <label
            className="tool-checkbox"
            title={'Show every row, including ones hidden by the filters (show filters, Min Lists, score range). Failing rows are faded; cells hidden by a user\'s status filter are dimmed instead of blank.\n\nThe count, footer stats, and Stat column still use only the rows and cells that pass.'}
          >
            <input
              type="checkbox"
              checked={showAllRows}
              onChange={(e) => patch({ showAllRows: e.target.checked })}
            />
            Show all rows
          </label>
        </div>
        <div className="filter-bar tool-score-compare-filters">
          <ScoreRangeChip
            pill={filters.score.pill}
            min={filters.score.min}
            max={filters.score.max}
            mode={filters.score.mode}
            onModeChange={(mode) => patchFilters({ score: { ...filters.score, mode } })}
            onChange={(next) =>
              patchFilters({
                score: {
                  ...filters.score,
                  pill: next.userScoreInclude ?? filters.score.pill,
                  min: next.scoreMin !== undefined ? next.scoreMin : filters.score.min,
                  max: next.scoreMax !== undefined ? next.scoreMax : filters.score.max,
                },
              })
            }
          />
          <AnilistChips
            externalIds={mediaIdSet}
            chipState={chipState}
            onChipStateChange={(next) => patch({ chipState: next })}
            hideUserChips
          />
        </div>
        <div className="tool-actions">
          <button
            type="button"
            className="btn primary"
            disabled={settings.usernames.length === 0}
            onClick={compare}
          >
            Compare
          </button>
        </div>
      </div>
      {usernames.length > 0 && (
        <ComparisonTable
          usernames={usernames}
          states={states}
          rows={displayRows}
          summaries={summaries}
          passingCount={passingCount}
          totalCount={rows.length}
          settings={settings}
          mediaType={mediaType}
          ctx={ctx}
          onSort={(column) => patch({ sort: nextComparisonSort(sort, column) })}
          onStatusesChange={(name, statuses) =>
            patchFilters({ userStatuses: { ...filters.userStatuses, [userKey(name)]: statuses } })
          }
          onStatChange={(next) => patch({ stat: next })}
          onOpenMedia={onOpenMedia}
        />
      )}
    </section>
  );
}
