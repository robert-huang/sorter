import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelFranchiseEntries } from '../toolsDisplayRelabel';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import {
  runFranchiseScores,
  type FranchiseRunProgress,
} from './franchiseScoresApi';
import {
  DEFAULT_RELATION_TOGGLES,
  FRANCHISE_RELATION_LABELS,
  FRANCHISE_RELATION_TYPES,
  formatFranchiseScoreLabel,
  franchiseDateLabel,
  type FranchiseEntry,
  type FranchiseForm,
  type FranchiseRelationType,
} from './franchiseScoresLogic';

const LS_KEY = 'anime-tools-franchise-scores-form';

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

function FranchiseColumnsView({
  entries,
  seedId,
  onOpenMedia,
}: {
  entries: FranchiseEntry[];
  seedId: number;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <div className="tool-season-columns">
      <DragScroll className="tool-season-scroll" initialScrollEnd>
        <div className="tool-season-body">
          {entries.map((entry) => {
            const isSeed = entry.id === seedId;
            const dateLabel = franchiseDateLabel(entry.startDate);
            const formatLabel = entry.format ?? entry.mediaType;
            return (
              <div
                key={entry.id}
                className={`tool-season-column tool-franchise-column${isSeed ? ' tool-franchise-column--seed' : ''}`}
              >
                <div className="tool-season-col-head">
                  <ToolShowButton
                    mediaId={entry.id}
                    title={entry.title}
                    coverImage={entry.coverImage}
                    mediaType={entry.mediaType}
                    onOpenMedia={onOpenMedia}
                    compact
                    className="tool-franchise-title"
                  />
                  <div className="tool-season-col-avg tool-franchise-meta">
                    <span>{dateLabel}</span>
                    <span
                      className="tool-franchise-format"
                      title={`AniList format: ${formatLabel}`}
                    >
                      {formatLabel}
                    </span>
                  </div>
                </div>
                <div className="tool-season-cell">
                  <div className="tool-season-cell-grid tool-franchise-score-cell">
                    <span
                      className="tool-season-score"
                      title={
                        entry.listStatus
                          ? `On list: ${entry.listStatus}`
                          : 'Not on your list (unwatched)'
                      }
                    >
                      {formatFranchiseScoreLabel(entry.score, entry.listStatus)}
                    </span>
                    {isSeed && <span className="tool-franchise-seed-tag">seed</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </DragScroll>
    </div>
  );
}

export function FranchiseScoresPanel({ onOpenMedia }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh();
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<FranchiseForm>(() => loadForm());
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
            <em>Source</em> / <em>Adaptation</em>; scores come from your manga list.
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
        <div className="tool-season-fullbleed">
          <FranchiseColumnsView
            entries={result.entries}
            seedId={result.seed.id}
            onOpenMedia={onOpenMedia}
          />
        </div>
      )}
    </section>
  );
}
