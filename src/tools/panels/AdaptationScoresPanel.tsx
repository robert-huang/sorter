import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { withLastAnilistUsername, writeLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import {
  runAdaptationScores,
  type AdaptationRunProgress,
  type AdaptationScanData,
} from './adaptationScoresApi';
import {
  DEFAULT_ADAPTATION_FILTERS,
  ADAPTATION_LIST_STATUS_OPTIONS,
  buildAdaptationDisplay,
  normalizeAdaptationListStatuses,
  type AdaptationFilters,
  type AdaptationScoresResult,
  type AdaptationTableCell,
  type AdaptationTableRow,
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
  };
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
  const scoreLabel = formatFranchiseScoreLabel(cell.media.score, cell.media.listStatus);
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

function AdaptationTable({
  rows,
  onOpenMedia,
}: {
  rows: AdaptationTableRow[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <DragScroll className="tool-adaptation-scroll">
      <table className="tool-adaptation-table">
      <thead>
        <tr>
          <th className="tool-adaptation-th tool-adaptation-col-source tool-table-col-divider">
            Source
          </th>
          <th className="tool-adaptation-th tool-adaptation-col-adaptation">Adaptation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`adaptation-row-${index}`} className="tool-adaptation-row">
            {row.source ? (
              <AdaptationCell column="source" cell={row.source} onOpenMedia={onOpenMedia} />
            ) : null}
            {row.adaptation ? (
              <AdaptationCell
                column="adaptation"
                cell={row.adaptation}
                onOpenMedia={onOpenMedia}
              />
            ) : null}
          </tr>
        ))}
      </tbody>
      </table>
    </DragScroll>
  );
}

export function AdaptationScoresPanel({ onOpenMedia }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshManga: true,
  });
  useToolsDisplayLabelRevision();
  const [form, setForm] = useState<AdaptationForm>(() => loadForm());
  const [filters, setFilters] = useState<AdaptationFilters>(() => loadFilters());
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
    if (!scan || scan.pairs.length === 0) {
      return result;
    }
    return buildAdaptationDisplay(scan.pairs, scan.mediaMap, scan.listScope, filters);
  }, [filters, result, scan]);

  const tableRows = useMemo(() => {
    if (displayResult?.kind !== 'table') {
      return [];
    }
    return displayResult.blocks.flatMap((block) => block.rows);
  }, [displayResult]);

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

      {displayResult?.kind === 'table' && tableRows.length > 0 && (
        <div className="tool-chart-fullbleed tool-adaptation-fullbleed">
          <div className="tool-adaptation-scroll-card">
            <AdaptationTable rows={tableRows} onOpenMedia={onOpenMedia} />
          </div>
        </div>
      )}
    </section>
  );
}
