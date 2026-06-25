import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelSeasonalShows } from '../toolsDisplayRelabel';
import { fetchUserSeasonalShows } from './seasonalScoresApi';
import {
  buildSeasonalColumns,
  effectiveSeasonalForm,
  formatSeasonColumnLabel,
  formatSeasonalScoreLabel,
  type SeasonMode,
  type SeasonalScoresForm,
  type SeasonalScoresResult,
  type SeasonColumn,
  type SeasonalShow,
} from './seasonalScoresLogic';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { ToolShowButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import {
  anilistUrlForSeasonSearch,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';

const LS_KEY = 'anime-tools-seasonal-scores-form';
/** @deprecated migrated into {@link LS_KEY} */
const LS_SEASON_TEXT_KEY = 'anime-tools-seasonal-scores-season-text';

const DEFAULT_FORM: SeasonalScoresForm = {
  username: '',
  seasonText: '',
  // Default new users to `allseasons` so first-run produces a useful chart
  // without forcing them to learn the textarea grammar.
  seasonMode: 'allseasons',
  skipEmpty: false,
  airingNotesOnly: false,
  includePlanning: false,
};

type PersistedSeasonalForm = Pick<
  SeasonalScoresForm,
  'seasonText' | 'seasonMode' | 'skipEmpty' | 'airingNotesOnly' | 'includePlanning'
>;

function normalizeSeasonMode(value: unknown): SeasonMode {
  if (value === 'all' || value === 'allseasons' || value === 'custom') {
    return value;
  }
  return 'allseasons';
}

function loadForm(): SeasonalScoresForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSeasonalForm>;
      const seasonText = parsed.seasonText ?? '';
      return {
        ...DEFAULT_FORM,
        seasonText,
        // Pre-toggle saves don't carry a mode — preserve the user's previous
        // textarea content by inferring `custom` when text exists, otherwise
        // fall through to the default.
        seasonMode:
          parsed.seasonMode != null
            ? normalizeSeasonMode(parsed.seasonMode)
            : seasonText.trim().length > 0
              ? 'custom'
              : DEFAULT_FORM.seasonMode,
        skipEmpty: parsed.skipEmpty ?? false,
        airingNotesOnly: parsed.airingNotesOnly ?? false,
        includePlanning: parsed.includePlanning ?? false,
        username: withLastAnilistUsername(''),
      };
    }
    const legacySeasonText = localStorage.getItem(LS_SEASON_TEXT_KEY) ?? '';
    return {
      ...DEFAULT_FORM,
      username: withLastAnilistUsername(''),
      seasonText: legacySeasonText,
      seasonMode: legacySeasonText.trim().length > 0 ? 'custom' : DEFAULT_FORM.seasonMode,
    };
  } catch {
    return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
  }
}

function saveForm(form: SeasonalScoresForm): void {
  try {
    const persisted: PersistedSeasonalForm = {
      seasonText: form.seasonText,
      seasonMode: form.seasonMode,
      skipEmpty: form.skipEmpty,
      airingNotesOnly: form.airingNotesOnly,
      includePlanning: form.includePlanning,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

const SEASON_MODE_OPTIONS: { value: SeasonMode; label: string; title: string }[] = [
  { value: 'all', label: 'All (Years)', title: "Compare full years from the user's list range." },
  {
    value: 'allseasons',
    label: 'All (Seasons)',
    title: "Split the user's list range into Winter/Spring/Summer/Fall columns.",
  },
  { value: 'custom', label: 'Custom', title: 'Type your own season list (one per line).' },
];

function SeasonalColumnsView({
  columns,
  onOpenMedia,
}: {
  columns: SeasonColumn[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  // Snap-to-right whenever the column SHAPE changes (different number of
  // columns, different mode, custom-season-list edit, etc.) — not when
  // only show labels change due to a display-language relabel. Column
  // labels ("Spring 2024", "2018", ...) are derived from form fields
  // that affect columns, so hashing them captures every settings change
  // that rebuilds the chart in place without triggering a parent
  // unmount/remount.
  const scrollEndKey = `${columns.length}|${columns.map((c) => c.label).join('|')}`;
  return (
    <div className="tool-season-columns">
      <DragScroll
        className="tool-season-scroll"
        initialScrollEnd
        scrollEndKey={scrollEndKey}
      >
        <div className="tool-season-body">
          {columns.map((col, colIdx) => {
            const searchLink = bindAnilistMiddleClick(
              anilistUrlForSeasonSearch(col.season, col.year),
            );
            return (
            <div key={`${colIdx}-${col.label}`} className="tool-season-column">
              <div className="tool-season-col-head">
                <div
                  className={mergeAnilistLinkClass(
                    'tool-season-col-title',
                    searchLink.className,
                  )}
                  onMouseDown={searchLink.onMouseDown}
                  onAuxClick={searchLink.onAuxClick}
                  title="Middle-click to search this season on AniList"
                >
                  {formatSeasonColumnLabel(col.label, col.ratedCount)}
                </div>
                <div className="tool-season-col-avg">avg: {col.average ?? 'N/A'}</div>
              </div>
              {col.shows.map((show) => (
                <div key={show.id} className="tool-season-cell">
                  <div className="tool-season-cell-grid">
                    <span className="tool-season-score">
                      {formatSeasonalScoreLabel(show.score, show.listStatus)}
                    </span>
                    <ToolShowButton
                      mediaId={show.id}
                      title={show.title}
                      coverImage={show.coverImage}
                      onOpenMedia={onOpenMedia}
                      compact
                      className="tool-season-title"
                    />
                  </div>
                </div>
              ))}
            </div>
            );
          })}
        </div>
      </DragScroll>
    </div>
  );
}

export function SeasonalScoresPanel({ onOpenMedia }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh();
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<SeasonalScoresForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SeasonalScoresResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const showsRef = useRef<SeasonalShow[] | null>(null);
  // Track what the cached shows in `showsRef` were fetched with so that form
  // changes which invalidate the cache (different user, planning toggled on
  // when the cache only has non-planning entries) can trigger a refetch or
  // clear instead of rendering stale data.
  const fetchedUsernameRef = useRef<string | null>(null);
  const fetchedIncludePlanningRef = useRef<boolean>(false);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  const patchForm = useCallback((patch: Partial<SeasonalScoresForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
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

    const includePlanningAtFetch = form.includePlanning;
    const handle = username.toLowerCase();

    setRunning(true);
    setError(null);
    setResult(null);
    showsRef.current = null;

    try {
      const shows = await fetchUserSeasonalShows(username, controller.signal, {
        includePlanning: includePlanningAtFetch,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      showsRef.current = shows;
      fetchedUsernameRef.current = handle;
      fetchedIncludePlanningRef.current = includePlanningAtFetch;
      setResult(
        buildSeasonalColumns(relabelSeasonalShows(shows), effectiveSeasonalForm(form)),
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load list.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }, [form]);

  useEffect(() => {
    if (!showsRef.current) {
      return;
    }
    const handle = form.username.trim().toLowerCase();
    // Different user typed in: drop the prior user's cached shows.
    if (fetchedUsernameRef.current !== null && handle !== fetchedUsernameRef.current) {
      showsRef.current = null;
      fetchedUsernameRef.current = null;
      fetchedIncludePlanningRef.current = false;
      setResult(null);
      return;
    }
    // Toggled Include Planning on but the cache was built without PLANNING entries:
    // auto-refetch so the columns actually include planning items.
    if (form.includePlanning && !fetchedIncludePlanningRef.current && !running) {
      void onRun(false);
      return;
    }
    setResult(
      buildSeasonalColumns(
        relabelSeasonalShows(showsRef.current),
        effectiveSeasonalForm(form),
      ),
    );
  }, [displayLabelRevision, form, running, onRun]);

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Compare average scores across seasons from a user&apos;s list — port of{' '}
        <code>compare_seasons.py</code>.
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

        <div className="tool-field tool-seasonal-mode-field">
          <div
            className="tool-segmented"
            role="group"
            aria-labelledby="seasonal-scores-mode-label"
          >
            {SEASON_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={form.seasonMode === option.value ? 'active' : ''}
                aria-pressed={form.seasonMode === option.value}
                disabled={running}
                title={option.title}
                onClick={() => patchForm({ seasonMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {form.seasonMode === 'custom' && (
            <>
              <span className="tool-field-hint">
                One per line: <code>all</code>, <code>allseasons</code>,{' '}
                <code>Winter 2024</code>, <code>2018</code>
              </span>
              <textarea
                className="tool-textarea csv-textarea"
                rows={6}
                disabled={running}
                value={form.seasonText}
                onChange={(e) => patchForm({ seasonText: e.target.value })}
                placeholder={'Winter 2024\nSpring 2024\nSummer 2024'}
              />
            </>
          )}
        </div>

        <div className="tool-field-row">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.skipEmpty}
              disabled={running}
              onChange={(e) => patchForm({ skipEmpty: e.target.checked })}
            />
            Skip empty seasons
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.airingNotesOnly}
              disabled={running}
              onChange={(e) => patchForm({ airingNotesOnly: e.target.checked })}
            />
            Only #airing notes
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.includePlanning}
              disabled={running}
              onChange={(e) => patchForm({ includePlanning: e.target.checked })}
            />
            Include Planning
          </label>
        </div>

        <div className="tool-actions">
          <ToolRunButton
            label="Compare"
            running={running}
            onRun={(forceRefresh) => void onRun(forceRefresh)}
          />
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {running && <p className="tool-status">Loading user list…</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result?.kind === 'empty' && <p className="tool-empty">{result.message}</p>}

      {result?.kind === 'columns' && (
        <div className="tool-season-fullbleed">
          <SeasonalColumnsView columns={result.columns} onOpenMedia={onOpenMedia} />
        </div>
      )}
    </section>
  );
}
