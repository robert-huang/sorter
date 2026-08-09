import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import {
  ToolAnimeMangaMediaTypeFilter,
  ToolSegmentedFilter,
} from '../ToolSegmentedFilter';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelFranchiseEntries } from '../toolsDisplayRelabel';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { AnilistMiddleClickLink } from '../../lib/importers/anilist/AnilistMiddleClickLink';
import { MultiSelectChip, toggleInArray } from '../../lib/importers/anilist/filters';
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
  formatFranchiseFormatFilterLabel,
  formatFranchiseScoreLabel,
  franchiseDateLabel,
  franchiseFormatLabel,
  FRANCHISE_FORMAT_OPTIONS,
  FRANCHISE_LIST_STATUS_OPTIONS,
  normalizeFranchiseListStatuses,
  normalizeFranchiseFormatFilters,
  type FranchiseEntry,
  type FranchiseFilters,
  type FranchiseForm,
  type FranchiseRelationType,
} from './franchiseScoresLogic';
import { scoreDisplayToneClass } from './seasonalScoresLogic';
import {
  adaptationListMediaTypesToFilters,
  adaptationSelectedListMediaTypes,
} from './adaptationScoresLogic';
import { ScoreRangeChip } from '../../lib/importers/anilist/filters';
import { useCurrentAnilistFavourites } from '../useCurrentAnilistFavourites';
import {
  fetchFranchiseActivities,
  type FranchiseActivitiesProgress,
} from './franchiseActivitiesApi';
import {
  buildFranchiseActivitiesCsv,
  buildFranchiseActivitiesPlainText,
  DEFAULT_FRANCHISE_ACTIVITY_TYPES,
  filterFranchiseActivitiesByType,
  formatFranchiseActivityDate,
  formatFranchiseActivityText,
  formatFranchiseActivityType,
  FRANCHISE_ACTIVITY_TYPE_OPTIONS,
  groupFranchiseActivitiesByMedia,
  sortFranchiseActivitiesByDate,
  type FranchiseActivity,
  type FranchiseActivityType,
  type FranchiseActivityViewMode,
} from './franchiseActivitiesLogic';

const LS_KEY = 'anime-tools-franchise-scores-form';
const LS_FILTERS_KEY = 'anime-tools-franchise-scores-filters';
export const FRANCHISE_ACTIVITY_VIEW_LS_KEY =
  'anime-tools-franchise-activities-view';
const EMPTY_MEDIA_ID_SET: ReadonlySet<number> = new Set();
export const FRANCHISE_ACTIVITY_DEBOUNCE_MS = 750;

function loadActivityView(): FranchiseActivityViewMode {
  try {
    const stored = localStorage.getItem(FRANCHISE_ACTIVITY_VIEW_LS_KEY);
    return stored === 'media' ? 'media' : 'date';
  } catch {
    return 'date';
  }
}

function saveActivityView(view: FranchiseActivityViewMode): void {
  try {
    localStorage.setItem(FRANCHISE_ACTIVITY_VIEW_LS_KEY, view);
  } catch {
    /* Ignore unavailable storage; the mounted view still retains the setting. */
  }
}

const DEFAULT_FORM: FranchiseForm = {
  username: '',
  showText: '',
  relationTypes: DEFAULT_RELATION_TOGGLES,
};

type PersistedForm = Pick<FranchiseForm, 'username' | 'showText' | 'relationTypes'>;

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
        username: withLastAnilistUsername(parsed.username ?? ''),
        showText: parsed.showText ?? '',
        relationTypes: normalizeRelationToggles(parsed.relationTypes),
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
      username: form.username,
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
  const listStatuses = normalizeFranchiseListStatuses(obj.listStatuses);
  const formatFilters = normalizeFranchiseFormatFilters(obj.formatFilters);
  return {
    includeAnime,
    includeManga,
    listStatuses,
    formatFilters,
    userScoreInclude,
    scoreMin,
    scoreMax,
  };
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

function describeActivityProgress(
  progress: FranchiseActivitiesProgress | null,
): string {
  if (!progress || progress.phase === 'cache') {
    return 'Loading activities…';
  }
  return `Loading activities (page ${progress.page}, ${progress.collected} found)…`;
}

function ActivitiesToggleChip({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`filter-chip ${active ? 'active' : ''} filter-chip--summary`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-pressed={active}
        onClick={onToggle}
      >
        Show activities
      </button>
    </div>
  );
}

export function FranchiseTable({
  entries,
  seedId,
  seedTitle,
  onOpenMedia,
  activitiesEnabled = false,
  uncheckedActivityMediaIds = EMPTY_MEDIA_ID_SET,
  onToggleActivityMedia = () => {},
}: {
  entries: FranchiseEntry[];
  seedId: number;
  seedTitle: string;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  activitiesEnabled?: boolean;
  uncheckedActivityMediaIds?: ReadonlySet<number>;
  onToggleActivityMedia?: (mediaId: number) => void;
}) {
  const favourites = useCurrentAnilistFavourites();
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
            {activitiesEnabled && (
              <th className="tool-franchise-th-activities">Show Activities</th>
            )}
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
              entry.mediaType,
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
                    favourite={favourites.mediaIds.has(entry.id)}
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
                {activitiesEnabled && (
                  <td className="tool-franchise-td-activities">
                    <input
                      type="checkbox"
                      checked={!uncheckedActivityMediaIds.has(entry.id)}
                      aria-label={`Show activities for ${entry.title}`}
                      onChange={() => onToggleActivityMedia(entry.id)}
                    />
                  </td>
                )}
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
  const completedRunRef = useRef<{ username: string; showText: string } | null>(
    null,
  );
  const relationTypesKey = useMemo(
    () =>
      FRANCHISE_RELATION_TYPES.map((type) =>
        form.relationTypes[type] ? `${type}:1` : `${type}:0`,
      ).join('|'),
    [form.relationTypes],
  );
  const previousRelationTypesKeyRef = useRef(relationTypesKey);

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

  const runForForm = useCallback(
    async (
      runForm: FranchiseForm,
      forceRefresh = false,
      preserveResult = false,
    ) => {
      const username = runForm.username.trim();
      const showText = runForm.showText.trim();
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
      setProgress(null);
      if (!preserveResult) {
        setResult(null);
        entriesRef.current = null;
      }

      try {
        const run = await runFranchiseScores({
          seedSearch: showText,
          username,
          relationToggles: runForm.relationTypes,
          signal: controller.signal,
          onProgress: setProgress,
          fetchOptions: forceRefresh ? { forceRefresh: true } : undefined,
        });
        entriesRef.current = { entries: run.entries, seed: run.seed };
        completedRunRef.current = { username, showText };
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
    [],
  );

  const onRun = useCallback(
    (forceRefresh = false) => runForForm(form, forceRefresh),
    [form, runForForm],
  );

  // Once a franchise has been traced, changing relation types immediately
  // re-walks that same graph. Relation reads stay DB-first; only newly reached
  // nodes whose expansion is missing or stale can require AniList.
  useEffect(() => {
    const previousKey = previousRelationTypesKeyRef.current;
    previousRelationTypesKeyRef.current = relationTypesKey;
    if (previousKey === relationTypesKey) {
      return;
    }

    const completedRun = completedRunRef.current;
    const username = form.username.trim();
    const showText = form.showText.trim();
    if (
      !completedRun ||
      !entriesRef.current ||
      completedRun.username !== username ||
      completedRun.showText !== showText
    ) {
      return;
    }

    void runForForm(form, false, true);
  }, [form, relationTypesKey, runForForm]);

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
            After the first trace, changing these types updates the results
            immediately.
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
          franchiseUsername={form.username.trim()}
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
export function FranchiseFilteredView({
  entries,
  seedId,
  seedTitle,
  franchiseUsername,
  filters,
  onPatchFilters,
  onOpenMedia,
}: {
  entries: FranchiseEntry[];
  seedId: number;
  seedTitle: string;
  franchiseUsername: string;
  filters: FranchiseFilters;
  onPatchFilters: (patch: Partial<FranchiseFilters>) => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const filtered = useMemo(
    () => applyFranchiseFilters(entries, filters),
    [entries, filters],
  );
  const [activitiesEnabled, setActivitiesEnabled] = useState(false);
  const [activityUsername, setActivityUsername] = useState(franchiseUsername);
  const [uncheckedActivityMediaIds, setUncheckedActivityMediaIds] = useState<
    Set<number>
  >(() => new Set());
  const [activities, setActivities] = useState<FranchiseActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityProgress, setActivityProgress] =
    useState<FranchiseActivitiesProgress | null>(null);
  const [activityRefreshVersion, setActivityRefreshVersion] = useState(0);
  const activityAbortRef = useRef<AbortController | null>(null);
  const forceActivityRefreshRef = useRef(false);
  const previousSeedIdRef = useRef(seedId);
  const activitiesUsernameRef = useRef(activityUsername.trim().toLocaleLowerCase());

  useEffect(() => {
    if (previousSeedIdRef.current === seedId) {
      return;
    }
    previousSeedIdRef.current = seedId;
    setUncheckedActivityMediaIds(new Set());
    setActivities([]);
    setActivityError(null);
  }, [seedId]);

  useEffect(() => {
    const normalizedUsername = activityUsername.trim().toLocaleLowerCase();
    if (activitiesUsernameRef.current === normalizedUsername) {
      return;
    }
    activitiesUsernameRef.current = normalizedUsername;
    setActivities([]);
    setActivityError(null);
  }, [activityUsername]);

  const selectedActivityEntries = useMemo(
    () =>
      filtered.filter(
        (entry) => !uncheckedActivityMediaIds.has(entry.id),
      ),
    [filtered, uncheckedActivityMediaIds],
  );
  const selectedActivityMediaIds = useMemo(
    () => selectedActivityEntries.map((entry) => entry.id),
    [selectedActivityEntries],
  );
  const selectedActivityMediaIdSet = useMemo(
    () => new Set(selectedActivityMediaIds),
    [selectedActivityMediaIds],
  );
  const entriesById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const displayActivities = useMemo(
    () =>
      activities
        .filter((activity) =>
          selectedActivityMediaIdSet.has(activity.media.id),
        )
        .map((activity) => {
          const entry = entriesById.get(activity.media.id);
          if (!entry) {
            return activity;
          }
          return {
            ...activity,
            media: {
              ...activity.media,
              title: entry.title,
              type: entry.mediaType,
              siteUrl: `https://anilist.co/${entry.mediaType.toLocaleLowerCase()}/${entry.id}`,
              format: entry.format,
              coverImage: entry.coverImage,
            },
          };
        }),
    [activities, entriesById, selectedActivityMediaIdSet],
  );

  useEffect(() => {
    if (!activitiesEnabled) {
      setActivityLoading(false);
      setActivityProgress(null);
      return;
    }
    const username = activityUsername.trim();
    if (!username) {
      setActivities([]);
      setActivityLoading(false);
      setActivityError('Enter an AniList username for activities.');
      return;
    }
    if (selectedActivityMediaIds.length === 0) {
      setActivities([]);
      setActivityLoading(false);
      setActivityError(null);
      return;
    }

    const controller = new AbortController();
    activityAbortRef.current?.abort();
    activityAbortRef.current = controller;
    setActivityLoading(true);
    setActivityError(null);
    setActivityProgress(null);
    const timer = window.setTimeout(() => {
      const forceRefresh = forceActivityRefreshRef.current;
      forceActivityRefreshRef.current = false;
      void fetchFranchiseActivities({
        username,
        mediaIds: selectedActivityMediaIds,
        signal: controller.signal,
        forceRefresh,
        onProgress: setActivityProgress,
      })
        .then((nextActivities) => {
          if (!controller.signal.aborted) {
            setActivities(nextActivities);
          }
        })
        .catch((activityFailure: unknown) => {
          if (
            !(activityFailure instanceof DOMException) ||
            activityFailure.name !== 'AbortError'
          ) {
            setActivityError(
              activityFailure instanceof Error
                ? activityFailure.message
                : 'Failed to load activities.',
            );
          }
        })
        .finally(() => {
          if (activityAbortRef.current === controller) {
            activityAbortRef.current = null;
            setActivityLoading(false);
            setActivityProgress(null);
          }
        });
    }, FRANCHISE_ACTIVITY_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (activityAbortRef.current === controller) {
        activityAbortRef.current = null;
      }
    };
  }, [
    activitiesEnabled,
    activityRefreshVersion,
    activityUsername,
    selectedActivityMediaIds,
  ]);

  const toggleActivityMedia = useCallback((mediaId: number) => {
    setUncheckedActivityMediaIds((current) => {
      const next = new Set(current);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }, []);

  const refreshActivities = useCallback(() => {
    forceActivityRefreshRef.current = true;
    setActivityRefreshVersion((version) => version + 1);
  }, []);

  const bothMediaOff = !filters.includeAnime && !filters.includeManga;
  return (
    <div className="tool-franchise-filtered">
      <FranchiseFilterBar
        filters={filters}
        activitiesEnabled={activitiesEnabled}
        totalCount={entries.length}
        visibleCount={filtered.length}
        onPatch={onPatchFilters}
        onToggleActivities={() => setActivitiesEnabled((enabled) => !enabled)}
        activityUsername={activityUsername}
        activityLoading={activityLoading}
        onActivityUsernameChange={setActivityUsername}
        onRefreshActivities={refreshActivities}
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
          activitiesEnabled={activitiesEnabled}
          uncheckedActivityMediaIds={uncheckedActivityMediaIds}
          onToggleActivityMedia={toggleActivityMedia}
        />
      )}
      {activitiesEnabled && (
        <FranchiseActivitiesSection
          activities={displayActivities}
          loading={activityLoading}
          error={activityError}
          progress={activityProgress}
          mediaOrder={selectedActivityMediaIds}
          seedTitle={seedTitle}
          onOpenMedia={onOpenMedia}
        />
      )}
    </div>
  );
}

export function FranchiseActivityRow({
  activity,
  showMedia,
  onOpenMedia,
}: {
  activity: FranchiseActivity;
  showMedia: boolean;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const replyLabel = `${activity.replyCount} ${
    activity.replyCount === 1 ? 'reply' : 'replies'
  }`;

  return (
    <li
      className={[
        'tool-franchise-activity-row',
        !showMedia ? 'tool-franchise-activity-row--without-media' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showMedia && (
        <AnilistMiddleClickLink
          className="tool-franchise-activity-media"
          url={activity.media.siteUrl}
          onPrimaryClick={() =>
            onOpenMedia(activity.media.id, activity.media.title)
          }
        >
          <span className="tool-franchise-activity-media-title">
            {activity.media.title}
          </span>
          <span
            className="tool-franchise-format"
            title={`AniList format: ${activity.media.format ?? activity.media.type}`}
          >
            {activity.media.format ?? activity.media.type}
          </span>
        </AnilistMiddleClickLink>
      )}
      <a
        className="tool-franchise-activity-main-link"
        href={activity.siteUrl}
        target="_blank"
        rel="noreferrer"
      >
        <span className="tool-franchise-activity-text">
          {formatFranchiseActivityText(activity)}
          {activity.replyCount > 0 && (
            <span
              className="tool-franchise-activity-replies"
              title={replyLabel}
              aria-label={replyLabel}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M2 2.25h12v8.5H7.15L3.5 13.8v-3.05H2V2.25Z" />
              </svg>
            </span>
          )}
        </span>
        <time
          className="tool-franchise-activity-date"
          dateTime={new Date(activity.createdAt * 1000).toISOString()}
        >
          {formatFranchiseActivityDate(activity.createdAt)}
        </time>
      </a>
    </li>
  );
}

export function FranchiseActivitiesSection({
  activities,
  loading,
  error,
  progress,
  mediaOrder,
  seedTitle,
  onOpenMedia,
}: {
  activities: FranchiseActivity[];
  loading: boolean;
  error: string | null;
  progress: FranchiseActivitiesProgress | null;
  mediaOrder: number[];
  seedTitle: string;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const [mode, setMode] =
    useState<FranchiseActivityViewMode>(loadActivityView);
  const [selectedTypes, setSelectedTypes] = useState<
    FranchiseActivityType[]
  >(() => [...DEFAULT_FRANCHISE_ACTIVITY_TYPES]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    saveActivityView(mode);
  }, [mode]);
  const filteredActivities = useMemo(
    () => filterFranchiseActivitiesByType(activities, selectedTypes),
    [activities, selectedTypes],
  );
  const chronologicalActivities = useMemo(
    () => sortFranchiseActivitiesByDate(filteredActivities),
    [filteredActivities],
  );
  const groupedActivities = useMemo(
    () => groupFranchiseActivitiesByMedia(filteredActivities, mediaOrder),
    [filteredActivities, mediaOrder],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        buildFranchiseActivitiesPlainText(
          filteredActivities,
          mode,
          mediaOrder,
        ),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser surfaces clipboard permission failures itself.
    }
  }, [filteredActivities, mediaOrder, mode]);

  const handleExportCsv = useCallback(() => {
    const baseFilename = franchiseCsvFilename(seedTitle).replace(/\.csv$/, '');
    downloadCsv(
      `${baseFilename}-activities.csv`,
      buildFranchiseActivitiesCsv(filteredActivities),
    );
  }, [filteredActivities, seedTitle]);

  return (
    <section className="tool-franchise-activities" aria-label="Franchise activities">
      <div className="tool-franchise-activities-toolbar">
        <MultiSelectChip
          label="activity type"
          options={FRANCHISE_ACTIVITY_TYPE_OPTIONS}
          selected={selectedTypes}
          formatOption={formatFranchiseActivityType}
          onToggle={(type) =>
            setSelectedTypes((current) => toggleInArray([...current], type))
          }
          onReplaceAll={(types) => setSelectedTypes([...types])}
        />
        <ToolSegmentedFilter
          unlabeled
          options={[
            { value: 'date', label: 'Date' },
            { value: 'media', label: 'Media' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <div className="tool-franchise-activity-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={filteredActivities.length === 0}
            onClick={() => void handleCopy()}
          >
            {copied ? 'Copied!' : 'Copy text'}
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={filteredActivities.length === 0}
            onClick={handleExportCsv}
          >
            Export CSV
          </button>
        </div>
      </div>

      {loading && (
        <p className="tool-status">{describeActivityProgress(progress)}</p>
      )}
      {error && <p className="tool-error">{error}</p>}
      {!loading && !error && filteredActivities.length === 0 && (
        <p className="tool-empty">
          {activities.length === 0
            ? 'No activities found for the selected media.'
            : 'No activities match the selected activity types.'}
        </p>
      )}

      {filteredActivities.length > 0 && mode === 'date' && (
        <ul className="tool-franchise-activity-list">
          {chronologicalActivities.map((activity) => (
            <FranchiseActivityRow
              key={activity.id}
              activity={activity}
              showMedia
              onOpenMedia={onOpenMedia}
            />
          ))}
        </ul>
      )}

      {filteredActivities.length > 0 && mode === 'media' && (
        <div className="tool-franchise-activity-groups">
          {groupedActivities.map((group) => (
            <section
              key={group.mediaId}
              className="tool-franchise-activity-group"
            >
              <div className="tool-franchise-activity-group-header">
                <AnilistMiddleClickLink
                  className="tool-franchise-activity-group-title"
                  url={group.mediaUrl}
                  onPrimaryClick={() =>
                    onOpenMedia(group.mediaId, group.mediaTitle)
                  }
                >
                  {group.activities[0]?.media.coverImage && (
                    <img
                      className="tool-franchise-activity-group-cover"
                      src={group.activities[0].media.coverImage}
                      alt=""
                    />
                  )}
                  <span className="tool-franchise-activity-group-title-text">
                    <span>{group.mediaTitle}</span>
                    <span
                      className="tool-franchise-format"
                      title={`AniList format: ${
                        group.activities[0]?.media.format ??
                        group.activities[0]?.media.type
                      }`}
                    >
                      {group.activities[0]?.media.format ??
                        group.activities[0]?.media.type}
                    </span>
                  </span>
                </AnilistMiddleClickLink>
              </div>
              <ul className="tool-franchise-activity-list">
                {group.activities.map((activity) => (
                  <FranchiseActivityRow
                    key={activity.id}
                    activity={activity}
                    showMedia={false}
                    onOpenMedia={onOpenMedia}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function FranchiseFilterBar({
  filters,
  activitiesEnabled,
  activityUsername,
  activityLoading,
  totalCount,
  visibleCount,
  onPatch,
  onToggleActivities,
  onActivityUsernameChange,
  onRefreshActivities,
}: {
  filters: FranchiseFilters;
  activitiesEnabled: boolean;
  activityUsername: string;
  activityLoading: boolean;
  totalCount: number;
  visibleCount: number;
  onPatch: (patch: Partial<FranchiseFilters>) => void;
  onToggleActivities: () => void;
  onActivityUsernameChange: (username: string) => void;
  onRefreshActivities: () => void;
}) {
  return (
    <div className="tool-franchise-filterbar">
      <div className="tool-franchise-filterbar-controls">
        <ToolAnimeMangaMediaTypeFilter
          allowMultiple
          value={adaptationSelectedListMediaTypes(filters)}
          onChange={(types) => onPatch(adaptationListMediaTypesToFilters(types))}
        />
        <MultiSelectChip
          label="list status"
          options={FRANCHISE_LIST_STATUS_OPTIONS}
          selected={filters.listStatuses}
          onToggle={(status) =>
            onPatch({
              listStatuses: toggleInArray([...filters.listStatuses], status),
            })
          }
          onReplaceAll={(statuses) => onPatch({ listStatuses: [...statuses] })}
        />
        <ScoreRangeChip
          pill={filters.userScoreInclude}
          min={filters.scoreMin}
          max={filters.scoreMax}
          onChange={(patch) => onPatch(patch)}
        />
        <MultiSelectChip
          label="format"
          options={FRANCHISE_FORMAT_OPTIONS}
          selected={filters.formatFilters}
          formatOption={formatFranchiseFormatFilterLabel}
          onToggle={(format) =>
            onPatch({
              formatFilters: toggleInArray([...filters.formatFilters], format),
            })
          }
          onReplaceAll={(formats) => onPatch({ formatFilters: [...formats] })}
        />
        <div className="tool-franchise-activity-controls">
          <ActivitiesToggleChip
            active={activitiesEnabled}
            onToggle={onToggleActivities}
          />
          {activitiesEnabled && (
            <div className="tool-franchise-activity-username">
              <ToolUsernameField
                inputAriaLabel="AniList username for activities"
                inputName="franchise-activity-username"
                value={activityUsername}
                refreshing={activityLoading}
                onChange={onActivityUsernameChange}
                onRefresh={onRefreshActivities}
                refreshLabel="Refresh selected activities from AniList"
              />
            </div>
          )}
        </div>
      </div>
      <span className="tool-franchise-filterbar-count">
        Showing {visibleCount} of {totalCount}
      </span>
    </div>
  );
}
