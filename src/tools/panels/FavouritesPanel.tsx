import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { runFavouritesAnalysis, type FavouritesRunProgress } from './favouritesApi';
import {
  rebuildFavouritesResult,
  type FavouritesForm,
  type FavouritesRebuildSource,
  type FavouritesResult,
  type FavouritesSeriesRow,
  type VaRankRow,
} from './favouritesLogic';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';

const LS_KEY = 'anime-tools-favourites-form';

const DEFAULT_FORM: FavouritesForm = {
  username: '',
};

function loadForm(): FavouritesForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
    }
    const parsed = JSON.parse(raw) as Partial<FavouritesForm & { useEnglishNames?: boolean }>;
    return {
      ...DEFAULT_FORM,
      username: withLastAnilistUsername(parsed.username ?? ''),
    };
  } catch {
    return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
  }
}

function saveForm(form: FavouritesForm): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(form));
  } catch {
    /* ignore */
  }
}

function progressLabel(progress: FavouritesRunProgress | null): string | null {
  if (!progress) {
    return null;
  }
  switch (progress.phase) {
    case 'list':
      return 'Loading user list…';
    case 'characters':
      return 'Loading favourite characters and staff…';
    case 'character-vas':
      return `Fetching VAs for ${progress.name} (${progress.index}/${progress.total})…`;
    case 'va-totals':
      return `Counting VA filmography (${progress.index}/${progress.total})…`;
    case 'build':
      return 'Building report…';
    default:
      return null;
  }
}

function VaRankBlock({
  title,
  rows,
  onOpenStaff,
  defaultOpen = false,
}: {
  title: string;
  rows: VaRankRow[];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  defaultOpen?: boolean;
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block" open={defaultOpen || undefined}>
      <summary className="tool-category-title">{title}</summary>
      <ul className="tool-rank-list">
        {rows.map((row) => (
          <li key={`${title}-${row.staffId}`}>
            <span className="tool-rank-count">{row.displayValue}</span>
            <ToolStaffButton
              staffId={row.staffId}
              name={row.name}
              imageUrl={row.imageUrl}
              onOpenStaff={onOpenStaff}
              compact
            />
            <span className="tool-rank-detail">{row.characterNames.join(', ')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SeriesListBlock({
  title,
  rows,
  onOpenMedia,
}: {
  title: string;
  rows: FavouritesSeriesRow[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">{title}</summary>
      {rows.map((row) => (
        <div key={row.mediaId} className="tool-series-row">
          <ToolShowButton
            mediaId={row.mediaId}
            title={row.title}
            coverImage={row.coverImage}
            mediaType={row.mediaType}
            onOpenMedia={onOpenMedia}
            compact
          />
          <span className="tool-rank-detail">{row.characters.join(', ')}</span>
        </div>
      ))}
    </details>
  );
}

function NameListBlock({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">
        {title} ({names.length})
      </summary>
      <p className="tool-name-list">{names.join(', ')}</p>
    </details>
  );
}

export function FavouritesPanel({ onOpenMedia, onOpenStaff }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshFavourites: true,
  });
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<FavouritesForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FavouritesRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FavouritesResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rebuildSourceRef = useRef<FavouritesRebuildSource | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    const source = rebuildSourceRef.current;
    if (!source) {
      return;
    }
    setResult(rebuildFavouritesResult(source));
  }, [displayLabelRevision]);

  const patchForm = useCallback((patch: Partial<FavouritesForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setProgress(null);
  }, []);

  const onRun = useCallback(async (forceRefresh = false) => {
    const username = form.username.trim();
    if (!username) {
      setError('Enter an AniList username.');
      setResult(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setResult(null);
    rebuildSourceRef.current = null;
    setProgress({ phase: 'list' });

    try {
      const { result: report, rebuildSource } = await runFavouritesAnalysis(
        form,
        setProgress,
        controller.signal,
        forceRefresh ? { forceRefresh: true } : undefined,
      );
      rebuildSourceRef.current = rebuildSource;
      setResult(report);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to run analysis.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
        setProgress(null);
      }
    }
  }, [form]);

  const statusText = progressLabel(progress);
  const mainRolePct =
    result && result.numSeen > 0
      ? Math.round((result.roles.main.length / result.numSeen) * 100)
      : null;

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Find voice actors behind your favourite characters — port of{' '}
        <code>character_vas.py</code>. First run can take a few minutes; character
        and VA lookups are cached in the browser (gear → Settings for display names).
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

        <div className="tool-actions">
          <ToolRunButton
            label="Analyze"
            running={running}
            forceRefreshTitle="Right-click to re-fetch favourites, character VAs, and anime list from AniList (bypass cache)"
            onRun={(forceRefresh) => void onRun(forceRefresh)}
          />
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {statusText && <p className="tool-status">{statusText}</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result && (
        <div className="tool-results favourites-results">
          <p className="tool-summary">
            {result.characterCount} favourite characters · {result.vaCount} VAs ·{' '}
            {result.numSeen} seen on your list
            {mainRolePct !== null ? ` · ~${mainRolePct}% main roles` : ''}
          </p>

          <VaRankBlock
            title="Top VAs by favourite character count"
            rows={result.byCount}
            onOpenStaff={onOpenStaff}
            defaultOpen
          />
          <VaRankBlock
            title="Top VAs by average favourite rank (Bayesian)"
            rows={result.byAvgRank}
            onOpenStaff={onOpenStaff}
          />
          <VaRankBlock
            title="Top VAs by log score"
            rows={result.byLogScore}
            onOpenStaff={onOpenStaff}
          />
          <VaRankBlock
            title="Top VAs by % of their characters favourited"
            rows={result.byPercent}
            onOpenStaff={onOpenStaff}
          />

          <NameListBlock
            title="Female characters"
            names={result.gender.female}
          />
          <NameListBlock title="Male characters" names={result.gender.male} />
          <NameListBlock title="Other / unknown gender" names={result.gender.other} />

          <NameListBlock title="Main roles" names={result.roles.main} />
          <NameListBlock title="Supporting roles" names={result.roles.supporting} />
          <NameListBlock title="Background roles" names={result.roles.background} />
          <NameListBlock title="Unknown roles" names={result.roles.unknown} />

          <details className="tool-category-block">
            <summary className="tool-category-title">Birthdays</summary>
            <ul className="tool-rank-list">
              {Object.entries(result.birthdays)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, names]) => (
                  <li key={day}>
                    <span className="tool-rank-count">{day}</span>
                    <span>{names.join(', ')}</span>
                  </li>
                ))}
            </ul>
          </details>

          <details className="tool-category-block">
            <summary className="tool-category-title">Favourite staff (VAs)</summary>
            <ul className="tool-rank-list">
              {result.favouriteStaff.map((staff) => (
                <li key={staff.id}>
                  <span className="tool-rank-count">{staff.matchedCount}</span>
                  <ToolStaffButton
                    staffId={staff.id}
                    name={staff.name}
                    imageUrl={staff.imageUrl}
                    onOpenStaff={onOpenStaff}
                    compact
                  />
                  {staff.gender ? (
                    <span className="tool-rank-detail">{staff.gender}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>

          <SeriesListBlock
            title="Characters by anime series"
            rows={result.seriesAnime}
            onOpenMedia={onOpenMedia}
          />

          <SeriesListBlock
            title="Characters by manga series"
            rows={result.seriesManga}
            onOpenMedia={onOpenMedia}
          />
        </div>
      )}
    </section>
  );
}
