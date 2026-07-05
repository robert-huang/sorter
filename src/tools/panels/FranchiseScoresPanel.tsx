import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelFranchiseEntries } from '../toolsDisplayRelabel';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import {
  runFranchiseScores,
  type FranchiseRunProgress,
} from './franchiseScoresApi';
import {
  applyFranchiseFilters,
  buildFranchiseClipboardText,
  buildFranchiseCsv,
  DEFAULT_FRANCHISE_FILTERS,
  DEFAULT_RELATION_TOGGLES,
  FRANCHISE_RELATION_LABELS,
  FRANCHISE_RELATION_TYPES,
  formatFranchiseScoreLabel,
  franchiseDateLabel,
  franchiseFormatLabel,
  type FranchiseEntry,
  type FranchiseFilters,
  type FranchiseForm,
  type FranchiseRelationType,
} from './franchiseScoresLogic';
import { scoreDisplayToneClass } from './seasonalScoresLogic';
import { ScoreRangeChip } from '../../lib/importers/anilist/filters';

const LS_KEY = 'anime-tools-franchise-scores-form';
const LS_FILTERS_KEY = 'anime-tools-franchise-scores-filters';

const DEFAULT_FORM: FranchiseForm = {
  username: '',
  showText: '',
  relationTypes: DEFAULT_RELATION_TOGGLES,
};

type PersistedForm = Pick<FranchiseForm, 'showText' | 'relationTypes'>;

function normalizeRelationToggles(
  raw: unknown,
): Record<FranchiseRelationType, boolean> {
  const out: Record<FranchiseRelationType, boolean> = { ...DEFAULT_RELATION_TOGGLES };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const type of FRANCHISE_RELATION_TYPES) {
      if (typeof obj[type] === 'boolean') {
        out[type] = obj[type] as boolean;
      }
    }
  }
  return out;
}

function loadForm(): FranchiseForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedForm>;
      return {
        ...DEFAULT_FORM,
        showText: parsed.showText ?? '',
        relationTypes: normalizeRelationToggles(parsed.relationTypes),
        username: withLastAnilistUsername(''),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
}

function saveForm(form: FranchiseForm): void {
  try {
    const persisted: PersistedForm = {
      showText: form.showText,
      relationTypes: form.relationTypes,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

/**
 * Coerce a persisted filter blob back into a fully-populated
 * {@link FranchiseFilters}. Each field is validated independently so a
 * partially-corrupt payload (e.g. a stale shape from a previous
 * version) still degrades cleanly to defaults instead of crashing on
 * load.
 */
function normalizeFilters(raw: unknown): FranchiseFilters {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FRANCHISE_FILTERS };
  }
  const obj = raw as Record<string, unknown>;
  const includeAnime =
    typeof obj.includeAnime === 'boolean'
      ? obj.includeAnime
      : DEFAULT_FRANCHISE_FILTERS.includeAnime;
  const includeManga =
    typeof obj.includeManga === 'boolean'
      ? obj.includeManga
      : DEFAULT_FRANCHISE_FILTERS.includeManga;
  const pillRaw = obj.userScoreInclude;
  const userScoreInclude =
    pillRaw === 'rated' || pillRaw === 'unrated' || pillRaw === 'any'
      ? pillRaw
      : DEFAULT_FRANCHISE_FILTERS.userScoreInclude;
  const scoreMin =
    typeof obj.scoreMin === 'number' && Number.isFinite(obj.scoreMin)
      ? obj.scoreMin
      : null;
  const scoreMax =
    typeof obj.scoreMax === 'number' && Number.isFinite(obj.scoreMax)
      ? obj.scoreMax
      : null;
  return { includeAnime, includeManga, userScoreInclude, scoreMin, scoreMax };
}

function loadFilters(): FranchiseFilters {
  try {
    const raw = localStorage.getItem(LS_FILTERS_KEY);
    if (raw) {
      return normalizeFilters(JSON.parse(raw));
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FRANCHISE_FILTERS };
}

function saveFilters(filters: FranchiseFilters): void {
  try {
    localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

function describeProgress(progress: FranchiseRunProgress | null): string {
  if (!progress) {
    return 'Loading…';
  }
  if (progress.phase === 'resolve') {
    return `Resolving "${progress.label}"…`;
  }
  if (progress.phase === 'walk') {
    return `Walking relations (${progress.visited} found, ${progress.queueDepth} queued) — ${progress.lastTitle}`;
  }
  return progress.mediaType === 'ANIME'
    ? 'Loading anime list…'
    : 'Loading manga list…';
}

type FranchiseResultState =
  | { kind: 'empty'; message: string }
  | {
      kind: 'columns';
      seed: { id: number; title: string };
      entries: FranchiseEntry[];
    };

/**
 * Sanitize a seed title into a filesystem-safe filename slug for the CSV
 * download. Strips runs of non-alphanumeric chars to a single hyphen and
 * trims edges; empty input falls back to `franchise`.
 */
function franchiseCsvFilename(seedTitle: string): string {
  const slug = seedTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `franchise-${slug || 'untitled'}.csv`;
}

function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FranchiseTable({
  entries,
  seedId,
  seedTitle,
  onOpenMedia,
}: {
  entries: FranchiseEntry[];
  seedId: number;
  seedTitle: string;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  // Brief visual confirmation that the clipboard write succeeded; clears
  // itself so a follow-up Copy fires the toast again.
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = buildFranchiseClipboardText(entries);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (non-HTTPS, permissions). Silently no-op —
      // browsers surface their own permission prompt; we don't need to
      // double-toast the failure.
    }
  }, [entries]);

  const handleExportCsv = useCallback(() => {
    downloadCsv(franchiseCsvFilename(seedTitle), buildFranchiseCsv(entries));
  }, [entries, seedTitle]);

  return (
    <div className="tool-franchise-result">
      <div className="tool-franchise-export-actions">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void handleCopy()}
          title="Copy each row as `title (format)` — newline-separated."
        >
          {copied ? 'Copied!' : 'Copy titles'}
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={handleExportCsv}
          title="Download a CSV with columns: Title, Format, Score."
        >
          Export CSV
        </button>
      </div>
      <table className="tool-franchise-table">
        <thead>
          <tr>
            <th className="tool-franchise-th-date">Date</th>
            <th className="tool-franchise-th-title">Title</th>
            <th className="tool-franchise-th-score">Score</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isSeed = entry.id === seedId;
            const dateLabel = franchiseDateLabel(entry.startDate);
            const formatLabel = franchiseFormatLabel(entry);
            const scoreLabel = formatFranchiseScoreLabel(
              entry.score,
              entry.listStatus,
            );
            const statusTitle = entry.listStatus
              ? `On list: ${entry.listStatus}`
              : 'Not on your list (unwatched)';
            return (
              <tr
                key={entry.id}
                className={
                  isSeed
                    ? 'tool-franchise-row tool-franchise-row--seed'
                    : 'tool-franchise-row'
                }
              >
                <td className="tool-franchise-td-date">{dateLabel}</td>
                <td className="tool-franchise-td-title">
                  <ToolShowButton
                    mediaId={entry.id}
                    title={entry.title}
                    coverImage={entry.coverImage}
                    mediaType={entry.mediaType}
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
                  {isSeed && (
                    <span className="tool-franchise-seed-tag">seed</span>
                  )}
                </td>
                <td
                  className={[
                    'tool-franchise-td-score',
                    scoreDisplayToneClass(entry.score),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={statusTitle}
                >
                  {scoreLabel}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FranchiseScoresPanel({ onOpenMedia }: ToolPanelProps) {
  // Refresh button must update BOTH the anime + manga lists (franchise
  // reads each user's list and stamps watched/scored status onto every
  // node). The lists themselves now live in the source DB via
  // ensureUserMediaListFresh — useUsernameListRefresh already
  // force-refreshes both there, so the next Trace will pick them up
  // automatically with no extra memo busting. Relation caches are
  // intentionally untouched — relations don't change when a user
  // updates their list.
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshManga: true,
  });
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<FranchiseForm>(() => loadForm());
  const [filters, setFilters] = useState<FranchiseFilters>(() => loadFilters());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FranchiseResultState | null>(null);
  const [progress, setProgress] = useState<FranchiseRunProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Stash the raw entries so display-preference changes can relabel
  // without refetching the network.
  const entriesRef = useRef<{
    entries: FranchiseEntry[];
    seed: { id: number; title: string };
  } | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const patchFilters = useCallback((patch: Partial<FranchiseFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const patchForm = useCallback((patch: Partial<FranchiseForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleRelation = useCallback((type: FranchiseRelationType) => {
    setError(null);
    setForm((prev) => ({
      ...prev,
      relationTypes: { ...prev.relationTypes, [type]: !prev.relationTypes[type] },
    }));
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
      const showText = form.showText.trim();
      if (!username) {
        setError('Enter an AniList username.');
        setResult(null);
        return;
      }
      if (!showText) {
        setError('Enter a show title to seed the franchise.');
        setResult(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setError(null);
      setResult(null);
      setProgress(null);
      entriesRef.current = null;

      try {
        const run = await runFranchiseScores({
          seedSearch: showText,
          username,
          relationToggles: form.relationTypes,
          signal: controller.signal,
          onProgress: setProgress,
          fetchOptions: forceRefresh ? { forceRefresh: true } : undefined,
        });
        entriesRef.current = { entries: run.entries, seed: run.seed };
        if (run.entries.length === 0) {
          setResult({
            kind: 'empty',
            message: `No franchise entries found for "${run.seed.title}".`,
          });
        } else {
          setResult({
            kind: 'columns',
            seed: run.seed,
            entries: relabelFranchiseEntries(run.entries),
          });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to load franchise.');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
          setProgress(null);
        }
      }
    },
    [form],
  );

  // Display-language preference changes — relabel cached entries.
  useEffect(() => {
    if (!entriesRef.current) {
      return;
    }
    setResult({
      kind: 'columns',
      seed: entriesRef.current.seed,
      entries: relabelFranchiseEntries(entriesRef.current.entries),
    });
  }, [displayLabelRevision]);

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Trace a show&apos;s franchise relations and chart your score / status
        for each entry, sorted by release date.
      </p>

      <form
        className="tool-form-card"
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
          refreshLabel="Refresh anime + manga lists from AniList"
        />

        <div className="tool-field">
          <label className="tool-field-label" htmlFor="franchise-seed-show">
            Seed show
          </label>
          <input
            id="franchise-seed-show"
            type="text"
            className="tool-input"
            disabled={running}
            value={form.showText}
            onChange={(e) => patchForm({ showText: e.target.value })}
            placeholder="e.g. Fate/Zero"
          />
          <span className="tool-field-hint">
            One show title — picks the most popular AniList match.
          </span>
        </div>

        <div className="tool-field">
          <span className="tool-field-label">Relation types to include</span>
          <div className="tool-franchise-toggles">
            {FRANCHISE_RELATION_TYPES.map((type) => {
              const meta = FRANCHISE_RELATION_LABELS[type];
              return (
                <label key={type} className="tool-checkbox" title={meta.hint}>
                  <input
                    type="checkbox"
                    checked={form.relationTypes[type]}
                    disabled={running}
                    onChange={() => toggleRelation(type)}
                  />
                  {meta.label}
                </label>
              );
            })}
          </div>
          <span className="tool-field-hint">
            Manga relations (source novels, manga adaptations) are pulled in via{' '}
            <em>Source</em> / <em>Adaptation</em>; scores come from your media list.
          </span>
        </div>

        <div className="tool-actions">
          <ToolRunButton
            label="Trace"
            running={running}
            onRun={(forceRefresh) => void onRun(forceRefresh)}
          />
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {running && <p className="tool-status">{describeProgress(progress)}</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result?.kind === 'empty' && <p className="tool-empty">{result.message}</p>}

      {result?.kind === 'columns' && (
        <FranchiseFilteredView
          entries={result.entries}
          seedId={result.seed.id}
          seedTitle={result.seed.title}
          filters={filters}
          onPatchFilters={patchFilters}
          onOpenMedia={onOpenMedia}
        />
      )}
    </section>
  );
}

/**
 * Filter row + table. Kept as a sibling component (rather than inlined
 * into the panel) so the `useMemo` for filtered entries doesn't have
 * to run during the form's hot edit path — and so the panel itself
 * stays focused on running / canceling / state. The Copy / CSV
 * buttons inside {@link FranchiseTable} operate on whatever entries
 * we pass in, so they automatically reflect the active filter
 * without needing extra plumbing.
 */
function FranchiseFilteredView({
  entries,
  seedId,
  seedTitle,
  filters,
  onPatchFilters,
  onOpenMedia,
}: {
  entries: FranchiseEntry[];
  seedId: number;
  seedTitle: string;
  filters: FranchiseFilters;
  onPatchFilters: (patch: Partial<FranchiseFilters>) => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const filtered = useMemo(
    () => applyFranchiseFilters(entries, filters),
    [entries, filters],
  );
  const bothMediaOff = !filters.includeAnime && !filters.includeManga;
  return (
    <div className="tool-franchise-filtered">
      <FranchiseFilterBar
        filters={filters}
        totalCount={entries.length}
        visibleCount={filtered.length}
        onPatch={onPatchFilters}
      />
      {bothMediaOff ? (
        <p className="tool-empty">
          Both Anime and Manga are unchecked — toggle at least one to see entries.
        </p>
      ) : filtered.length === 0 ? (
        <p className="tool-empty">No entries match the current filter.</p>
      ) : (
        <FranchiseTable
          entries={filtered}
          seedId={seedId}
          seedTitle={seedTitle}
          onOpenMedia={onOpenMedia}
        />
      )}
    </div>
  );
}

function FranchiseFilterBar({
  filters,
  totalCount,
  visibleCount,
  onPatch,
}: {
  filters: FranchiseFilters;
  totalCount: number;
  visibleCount: number;
  onPatch: (patch: Partial<FranchiseFilters>) => void;
}) {
  return (
    <div className="tool-franchise-filterbar">
      <div className="tool-franchise-filterbar-controls">
        <label className="tool-checkbox" title="Show ANIME entries from the franchise.">
          <input
            type="checkbox"
            checked={filters.includeAnime}
            onChange={(e) => onPatch({ includeAnime: e.target.checked })}
          />
          Anime
        </label>
        <label className="tool-checkbox" title="Show MANGA / NOVEL entries from the franchise.">
          <input
            type="checkbox"
            checked={filters.includeManga}
            onChange={(e) => onPatch({ includeManga: e.target.checked })}
          />
          Manga
        </label>
        <ScoreRangeChip
          pill={filters.userScoreInclude}
          min={filters.scoreMin}
          max={filters.scoreMax}
          onChange={(patch) => onPatch(patch)}
        />
      </div>
      <span className="tool-franchise-filterbar-count">
        Showing {visibleCount} of {totalCount}
      </span>
    </div>
  );
}
