import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { withLastAnilistUsername, writeLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import {
  applyHeaderScrollbarGutter,
  syncPairedTableColumnWidth,
  syncTableColumnsByClass,
} from '../../lib/chartSplitTableSync';
import {
  mergeAdaptationScanFromRelationsRefresh,
  runAdaptationScores,
  type AdaptationRunProgress,
  type AdaptationScanData,
} from './adaptationScoresApi';
import {
  DEFAULT_ADAPTATION_FILTERS,
  ADAPTATION_LIST_STATUS_OPTIONS,
  adaptationDiffDisplayToneClass,
  buildAdaptationDisplay,
  normalizeAdaptationListStatuses,
  type AdaptationDisplayBlock,
  type AdaptationFilters,
  type AdaptationScoresResult,
  type AdaptationTableCell,
  type ShowDifferenceMode,
} from './adaptationScoresLogic';
import {
  formatFranchiseScoreLabel,
  franchiseFormatLabel,
} from './franchiseScoresLogic';
import { scoreDisplayToneClass } from './seasonalScoresLogic';
import { MultiSelectChip, toggleInArray } from '../../lib/importers/anilist/filters';

const LS_KEY = 'anime-tools-adaptation-scores-form';
const LS_FILTERS_KEY = 'anime-tools-adaptation-scores-filters';

const HIDE_SAME_MEDIUM_TOOLTIP =
  'Hides pairs where source and adaptation are the same medium (manga or anime). ' +
  'Example: Bakemonogatari (novel) → Bakemonogatari (manga) would be hidden; novel → TV is kept.';

const CONSUMPTION_DOT_TOOLTIP =
  'You started this entry first in this group (earliest start date on your list).';

function formatDiffLabel(diff: number | null): string {
  if (diff === null) {
    return '—';
  }
  if (diff > 0) {
    return `+${diff}`;
  }
  return String(diff);
}

type DiffSort = 'desc' | 'asc' | null;

const SHOW_DIFFERENCE_MODE_OPTIONS: readonly {
  value: Exclude<ShowDifferenceMode, 'off'>;
  label: string;
}[] = [
  { value: 'source', label: 'Source' },
  { value: 'first', label: 'First' },
];

const SHOW_DIFFERENCE_TOOLTIP =
  'SOURCE: highest source score in the block minus highest adaptation score. ' +
  'FIRST: highest score on the opposite side of your consumption dot minus that dot item’s score.';

type AdaptationForm = {
  username: string;
};

type PersistedAdaptationForm = Pick<AdaptationForm, 'username'>;

const DEFAULT_FORM: AdaptationForm = {
  username: withLastAnilistUsername(''),
};

function loadForm(): AdaptationForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedAdaptationForm>;
      return {
        ...DEFAULT_FORM,
        username: withLastAnilistUsername(parsed.username ?? ''),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
}

function saveForm(form: AdaptationForm): void {
  try {
    const persisted: PersistedAdaptationForm = {
      username: form.username,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

function normalizeFilters(raw: unknown): AdaptationFilters {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_ADAPTATION_FILTERS };
  }
  const obj = raw as Record<string, unknown>;
  return {
    includeAnime:
      typeof obj.includeAnime === 'boolean'
        ? obj.includeAnime
        : DEFAULT_ADAPTATION_FILTERS.includeAnime,
    includeManga:
      typeof obj.includeManga === 'boolean'
        ? obj.includeManga
        : DEFAULT_ADAPTATION_FILTERS.includeManga,
    onlyBothOnList:
      typeof obj.onlyBothOnList === 'boolean'
        ? obj.onlyBothOnList
        : DEFAULT_ADAPTATION_FILTERS.onlyBothOnList,
    hideSameMedium:
      typeof obj.hideSameMedium === 'boolean'
        ? obj.hideSameMedium
        : DEFAULT_ADAPTATION_FILTERS.hideSameMedium,
    listStatuses: normalizeAdaptationListStatuses(obj.listStatuses),
    showDifference: normalizeShowDifference(obj.showDifference),
  };
}

function normalizeShowDifference(raw: unknown): ShowDifferenceMode {
  if (raw === 'source' || raw === 'first') {
    return raw;
  }
  return 'off';
}

function loadFilters(): AdaptationFilters {
  try {
    const raw = localStorage.getItem(LS_FILTERS_KEY);
    if (raw) {
      return normalizeFilters(JSON.parse(raw));
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_ADAPTATION_FILTERS };
}

function saveFilters(filters: AdaptationFilters): void {
  try {
    localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

function describeProgress(progress: AdaptationRunProgress | null): string {
  if (!progress) {
    return 'Loading…';
  }
  if (progress.phase === 'list') {
    return progress.mediaType === 'ANIME' ? 'Loading anime list…' : 'Loading manga list…';
  }
  return `Fetching relations ${progress.done}/${progress.total} — ${progress.title}`;
}

function startedAtTooltip(date: AdaptationTableCell['media']['startedAt']): string | undefined {
  if (!date?.year) {
    return undefined;
  }
  const month = date.month != null ? String(date.month).padStart(2, '0') : '??';
  const day = date.day != null ? String(date.day).padStart(2, '0') : '??';
  return `Started: ${date.year}-${month}-${day}`;
}

function AdaptationCell({
  cell,
  column,
  onOpenMedia,
}: {
  cell: AdaptationTableCell;
  column: 'source' | 'adaptation';
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  if (cell.skipRender) {
    return null;
  }
  const scoreLabel = formatFranchiseScoreLabel(
    cell.media.score,
    cell.media.listStatus,
    cell.media.mediaType,
  );
  const formatLabel = franchiseFormatLabel(cell.media);
  const statusTitle = cell.media.listStatus
    ? `On list: ${cell.media.listStatus}`
    : 'Not on your list (unwatched)';
  const startedTitle = startedAtTooltip(cell.media.startedAt);
  const title = [statusTitle, startedTitle].filter(Boolean).join(' · ');

  return (
    <td
      className={[
        'tool-adaptation-td',
        column === 'source'
          ? 'tool-adaptation-col-source tool-table-col-divider'
          : 'tool-adaptation-col-adaptation',
      ].join(' ')}
      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
      title={title}
    >
      <div className="tool-season-cell-grid">
        <span
          className={[
            'tool-season-score',
            scoreDisplayToneClass(cell.media.score),
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {scoreLabel}
        </span>
        <div className="tool-franchise-td-title">
          <ToolShowButton
            mediaId={cell.media.id}
            title={cell.media.title}
            coverImage={cell.media.coverImage}
            mediaType={cell.media.mediaType}
            onOpenMedia={onOpenMedia}
            compact
            className="tool-franchise-title-link"
          />
          <span
            className="tool-franchise-format"
            title={`AniList format: ${formatLabel}`}
          >
            {formatLabel}
          </span>
          {cell.showConsumptionDot ? (
            <span
              className="tool-adaptation-dot"
              title={CONSUMPTION_DOT_TOOLTIP}
              aria-label={CONSUMPTION_DOT_TOOLTIP}
            >
              •
            </span>
          ) : null}
        </div>
      </div>
    </td>
  );
}

function AdaptationTableColgroup({ showDiff }: { showDiff: boolean }) {
  return (
    <colgroup>
      <col className="tool-adaptation-col-source" />
      {showDiff ? <col className="tool-adaptation-col-diff" /> : null}
      <col className="tool-adaptation-col-adaptation" />
    </colgroup>
  );
}

function AdaptationDiffCell({
  diff,
  rowSpan,
}: {
  diff: number | null;
  rowSpan: number;
}) {
  return (
    <td
      className={[
        'tool-adaptation-td',
        'tool-adaptation-col-diff',
        'tool-table-col-divider',
      ]
        .filter(Boolean)
        .join(' ')}
      rowSpan={rowSpan > 1 ? rowSpan : undefined}
    >
      <span
        className={[
          'tool-adaptation-diff-value',
          adaptationDiffDisplayToneClass(diff),
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {formatDiffLabel(diff)}
      </span>
    </td>
  );
}

function AdaptationTable({
  blocks,
  showDifference,
  diffSort,
  onDiffSortClick,
  onOpenMedia,
}: {
  blocks: AdaptationDisplayBlock[];
  showDifference: ShowDifferenceMode;
  diffSort: DiffSort;
  onDiffSortClick: () => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const showDiff = showDifference !== 'off';
  const headerWrapRef = useRef<HTMLDivElement>(null);
  const headerTableRef = useRef<HTMLTableElement>(null);
  const bodyTableRef = useRef<HTMLTableElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);

  const syncColumnClasses = useMemo(
    () =>
      ['tool-adaptation-col-source', 'tool-adaptation-col-adaptation'] as const,
    [],
  );

  const syncTableLayout = useCallback(() => {
    const headerWrap = headerWrapRef.current;
    const bodyScroll = bodyScrollRef.current;
    const headerTable = headerTableRef.current;
    const bodyTable = bodyTableRef.current;
    if (!headerWrap || !bodyScroll || !headerTable || !bodyTable) {
      return;
    }
    applyHeaderScrollbarGutter(headerWrap, bodyScroll);
    syncTableColumnsByClass(headerTable, bodyTable, syncColumnClasses, undefined, {
      setTableWidth: false,
    });
    if (showDiff) {
      syncPairedTableColumnWidth(headerTable, bodyTable, 'tool-adaptation-col-diff');
    }
    const tableWidth = Math.max(headerTable.offsetWidth, bodyTable.offsetWidth);
    if (tableWidth > 0) {
      const widthPx = `${tableWidth}px`;
      headerTable.style.width = widthPx;
      bodyTable.style.width = widthPx;
    }
  }, [showDiff, syncColumnClasses]);

  useLayoutEffect(() => {
    syncTableLayout();
    const bodyScroll = bodyScrollRef.current;
    const bodyTable = bodyTableRef.current;
    if (!bodyScroll) {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncTableLayout();
    });
    observer.observe(bodyScroll);
    if (bodyTable) {
      observer.observe(bodyTable);
    }
    return () => {
      observer.disconnect();
    };
  }, [blocks, showDiff, diffSort, syncTableLayout]);

  const syncHeaderScroll = useCallback(
    (el: HTMLElement) => {
      if (headerWrapRef.current) {
        headerWrapRef.current.scrollLeft = el.scrollLeft;
      }
      syncTableLayout();
    },
    [syncTableLayout],
  );

  const diffSortIndicator =
    diffSort === 'desc' ? '↓' : diffSort === 'asc' ? '↑' : null;

  return (
    <>
      <div ref={headerWrapRef} className="tool-chart-pinned-header">
        <table
          ref={headerTableRef}
          className={[
            'tool-adaptation-table',
            'tool-chart-split-table',
            showDiff ? 'tool-chart-split-table--with-diff' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <AdaptationTableColgroup showDiff={showDiff} />
          <thead>
            <tr>
              <th className="tool-adaptation-th tool-adaptation-col-source tool-table-col-divider">
                Source
              </th>
              {showDiff ? (
                <th
                  className={[
                    'tool-adaptation-th',
                    'tool-adaptation-col-diff',
                    'tool-table-col-divider',
                    'tool-chart-sort-th',
                    diffSort ? 'tool-chart-sort-th--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={onDiffSortClick}
                  title="Sort franchise blocks by difference (click to cycle)"
                >
                  {diffSortIndicator ? (
                    <span className="tool-adaptation-diff-head">
                      Diff
                      <span className="tool-chart-sort-indicator" aria-hidden="true">
                        {diffSortIndicator}
                      </span>
                    </span>
                  ) : (
                    'Diff'
                  )}
                </th>
              ) : null}
              <th className="tool-adaptation-th tool-adaptation-col-adaptation">Adaptation</th>
            </tr>
          </thead>
        </table>
      </div>
      <DragScroll
        className="tool-adaptation-scroll tool-chart-body-scroll"
        scrollRef={bodyScrollRef}
        onUserScroll={syncHeaderScroll}
      >
        <table
          ref={bodyTableRef}
          className={[
            'tool-adaptation-table',
            'tool-chart-split-table',
            showDiff ? 'tool-chart-split-table--with-diff' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <AdaptationTableColgroup showDiff={showDiff} />
          <tbody>
            {blocks.map((block, blockIndex) =>
              block.rows.map((row, rowIndex) => (
                <tr
                  key={`adaptation-block-${blockIndex}-row-${rowIndex}`}
                  className={[
                    'tool-adaptation-row',
                    row.hiddenByFilter ? 'tool-adaptation-row-filtered-out' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {row.leadingSourceGap ? (
                    <td
                      className="tool-adaptation-td tool-adaptation-col-source tool-table-col-divider"
                      aria-hidden="true"
                    />
                  ) : null}
                  {row.source ? (
                    <AdaptationCell column="source" cell={row.source} onOpenMedia={onOpenMedia} />
                  ) : null}
                  {showDiff && rowIndex === 0 ? (
                    <AdaptationDiffCell diff={block.diff} rowSpan={block.rows.length} />
                  ) : null}
                  {row.adaptation ? (
                    <AdaptationCell
                      column="adaptation"
                      cell={row.adaptation}
                      onOpenMedia={onOpenMedia}
                    />
                  ) : null}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </DragScroll>
    </>
  );
}

export function AdaptationScoresPanel({
  onOpenMedia,
  bindMediaRelationsRefreshHandler,
}: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshManga: true,
  });
  useToolsDisplayLabelRevision();
  const [form, setForm] = useState<AdaptationForm>(() => loadForm());
  const [filters, setFilters] = useState<AdaptationFilters>(() => loadFilters());
  const [showAllRows, setShowAllRows] = useState(false);
  const [diffSort, setDiffSort] = useState<DiffSort>(null);
  const lastShowDifferenceModeRef = useRef<Exclude<ShowDifferenceMode, 'off'>>('source');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdaptationScoresResult | null>(null);
  const [scan, setScan] = useState<AdaptationScanData | null>(null);
  const [progress, setProgress] = useState<AdaptationRunProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  useEffect(() => {
    if (filters.showDifference !== 'off') {
      lastShowDifferenceModeRef.current = filters.showDifference;
    }
  }, [filters.showDifference]);

  useEffect(() => {
    if (filters.showDifference === 'off') {
      setDiffSort(null);
    }
  }, [filters.showDifference]);

  const cycleDiffSort = useCallback(() => {
    setDiffSort((prev) => {
      if (prev === null) {
        return 'desc';
      }
      if (prev === 'desc') {
        return 'asc';
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!bindMediaRelationsRefreshHandler) {
      return;
    }
    bindMediaRelationsRefreshHandler((mediaId, response) => {
      setScan((prev) => {
        if (!prev) {
          return prev;
        }
        return mergeAdaptationScanFromRelationsRefresh(prev, mediaId, response);
      });
    });
    return () => bindMediaRelationsRefreshHandler(null);
  }, [bindMediaRelationsRefreshHandler]);

  const patchFilters = useCallback((patch: Partial<AdaptationFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const patchForm = useCallback((patch: Partial<AdaptationForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setProgress(null);
  }, []);

  const onRun = useCallback(
    async (forceRefresh = false) => {
      const username = form.username.trim();
      if (!username) {
        setError('Enter an AniList username.');
        setResult(null);
        setScan(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setError(null);
      setProgress(null);
      setDiffSort(null);

      try {
        const next = await runAdaptationScores({
          username,
          filters,
          signal: controller.signal,
          onProgress: setProgress,
          fetchOptions: forceRefresh ? { forceRefresh: true } : undefined,
        });
        setScan(next.scan);
        setResult(next.display);
        writeLastAnilistUsername(username);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setResult(null);
        setScan(null);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setRunning(false);
        setProgress(null);
      }
    },
    [filters, form.username],
  );

  const displayResult = useMemo(() => {
    if (!scan || scan.links.length === 0) {
      return result;
    }
    return buildAdaptationDisplay(scan.links, scan.mediaMap, scan.listScope, filters, {
      showAllRows,
    });
  }, [filters, result, scan, showAllRows]);

  const tableBlocks = useMemo(() => {
    if (displayResult?.kind !== 'table') {
      return [];
    }
    let blocks = displayResult.blocks;
    if (diffSort && filters.showDifference !== 'off') {
      blocks = [...blocks].sort((a, b) => {
        const aDiff = a.diff;
        const bDiff = b.diff;
        if (aDiff === null && bDiff === null) {
          return a.sortKey - b.sortKey;
        }
        if (aDiff === null) {
          return 1;
        }
        if (bDiff === null) {
          return -1;
        }
        const cmp = diffSort === 'desc' ? bDiff - aDiff : aDiff - bDiff;
        return cmp !== 0 ? cmp : a.sortKey - b.sortKey;
      });
    }
    return blocks;
  }, [diffSort, displayResult, filters.showDifference]);

  const hasTableRows = tableBlocks.some((block) => block.rows.length > 0);

  const bothMediaOff = !filters.includeAnime && !filters.includeManga;

  return (
    <section className="tool-panel tool-adaptation-scores-panel">
      <p className="tool-panel-lead">
        Map source and adaptation pairs from your anime and manga lists, grouped
        into franchise blocks with scores and list status.
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
        <div className="tool-adaptation-primary-filters">
          <ToolUsernameField
            label="AniList username"
            value={form.username}
            disabled={running}
            refreshing={refreshingList}
            onChange={(username) => patchForm({ username })}
            onRefresh={() => refreshUsernameList(form.username, running)}
            refreshLabel="Refresh anime + manga lists from AniList"
          />
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={filters.includeAnime}
              onChange={(e) => patchFilters({ includeAnime: e.target.checked })}
            />
            Anime List
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={filters.includeManga}
              onChange={(e) => patchFilters({ includeManga: e.target.checked })}
            />
            Manga List
          </label>
          <MultiSelectChip
            label="list status"
            options={ADAPTATION_LIST_STATUS_OPTIONS}
            selected={filters.listStatuses}
            onToggle={(status) =>
              patchFilters({
                listStatuses: toggleInArray([...filters.listStatuses], status),
              })
            }
            onReplaceAll={(statuses) => patchFilters({ listStatuses: [...statuses] })}
          />
        </div>
        <div className="tool-field-row tool-field-row-wrap tool-adaptation-filters">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={filters.onlyBothOnList}
              onChange={(e) => patchFilters({ onlyBothOnList: e.target.checked })}
            />
            Only rows where both sides are on my list
          </label>
          <label className="tool-checkbox" title={HIDE_SAME_MEDIUM_TOOLTIP}>
            <input
              type="checkbox"
              checked={filters.hideSameMedium}
              onChange={(e) => patchFilters({ hideSameMedium: e.target.checked })}
            />
            Hide same-medium adaptations
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={showAllRows}
              onChange={(e) => setShowAllRows(e.target.checked)}
            />
            Show all rows
          </label>
          <div className="tool-adaptation-show-diff-field" title={SHOW_DIFFERENCE_TOOLTIP}>
            <label className="tool-checkbox">
              <input
                type="checkbox"
                checked={filters.showDifference !== 'off'}
                onChange={(e) => {
                  if (e.target.checked) {
                    patchFilters({
                      showDifference: lastShowDifferenceModeRef.current,
                    });
                  } else {
                    patchFilters({ showDifference: 'off' });
                  }
                }}
              />
              Show score diff
            </label>
            {filters.showDifference !== 'off' ? (
              <select
                className="slot-search tool-adaptation-show-diff"
                value={filters.showDifference}
                onChange={(e) => {
                  const mode = e.target.value as Exclude<ShowDifferenceMode, 'off'>;
                  lastShowDifferenceModeRef.current = mode;
                  patchFilters({ showDifference: mode });
                }}
              >
                {SHOW_DIFFERENCE_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
        <div className="tool-actions">
          <ToolRunButton
            label="Compare"
            running={running}
            disabled={bothMediaOff}
            onRun={(forceRefresh) => void onRun(forceRefresh)}
          />
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {running && (
          <p className="tool-status" aria-live="polite">
            {describeProgress(progress)}
          </p>
        )}
        {error && <p className="tool-error">{error}</p>}
        {bothMediaOff && (
          <p className="tool-hint">Enable anime or manga to scan list entries.</p>
        )}
      </form>

      {displayResult?.kind === 'empty' && (
        <p className="tool-empty">{displayResult.message}</p>
      )}

      {displayResult?.kind === 'table' && hasTableRows && (
        <div className="tool-chart-fullbleed tool-adaptation-fullbleed">
          <div className="tool-adaptation-scroll-card">
            <AdaptationTable
              blocks={tableBlocks}
              showDifference={filters.showDifference}
              diffSort={diffSort}
              onDiffSortClick={cycleDiffSort}
              onOpenMedia={onOpenMedia}
            />
          </div>
        </div>
      )}
    </section>
  );
}
