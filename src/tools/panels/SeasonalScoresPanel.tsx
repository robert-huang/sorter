import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { fetchUserSeasonalShows } from './seasonalScoresApi';
import {
  buildSeasonalColumns,
  type SeasonalScoresForm,
  type SeasonalScoresResult,
  type SeasonColumn,
} from './seasonalScoresLogic';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';

const LS_KEY = 'anime-tools-seasonal-scores-form';
/** @deprecated migrated into {@link LS_KEY} */
const LS_SEASON_TEXT_KEY = 'anime-tools-seasonal-scores-season-text';

const DEFAULT_FORM: SeasonalScoresForm = {
  username: '',
  seasonText: '',
  skipEmpty: false,
  airingNotesOnly: false,
};

type PersistedSeasonalForm = Pick<
  SeasonalScoresForm,
  'seasonText' | 'skipEmpty' | 'airingNotesOnly'
>;

function loadForm(): SeasonalScoresForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSeasonalForm>;
      return {
        ...DEFAULT_FORM,
        seasonText: parsed.seasonText ?? '',
        skipEmpty: parsed.skipEmpty ?? false,
        airingNotesOnly: parsed.airingNotesOnly ?? false,
        username: withLastAnilistUsername(''),
      };
    }
    return {
      ...DEFAULT_FORM,
      username: withLastAnilistUsername(''),
      seasonText: localStorage.getItem(LS_SEASON_TEXT_KEY) ?? '',
    };
  } catch {
    return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
  }
}

function saveForm(form: SeasonalScoresForm): void {
  try {
    const persisted: PersistedSeasonalForm = {
      seasonText: form.seasonText,
      skipEmpty: form.skipEmpty,
      airingNotesOnly: form.airingNotesOnly,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

function SeasonalColumnsView({
  columns,
  onOpenMedia,
}: {
  columns: SeasonColumn[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <div className="tool-season-columns">
      <div className="tool-season-scroll">
        <div className="tool-season-body">
          {columns.map((col) => (
            <div key={col.label} className="tool-season-column">
              <div className="tool-season-col-head">
                <div className="tool-season-col-title">{col.label}</div>
                <div className="tool-season-col-avg">avg: {col.average ?? 'N/A'}</div>
              </div>
              {col.shows.map((show) => (
                <div key={show.id} className="tool-season-cell">
                  <div className="tool-season-cell-grid">
                    <span className="tool-season-score">{show.score ?? '—'}</span>
                    <button
                      type="button"
                      className="tool-link-btn tool-season-title"
                      onClick={() =>
                        onOpenMedia(show.id, show.title, { forceRefresh: true })
                      }
                    >
                      {show.title}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SeasonalScoresPanel({ onOpenMedia }: ToolPanelProps) {
  const { hint: usernameHint, onUsernameContextMenu } = useUsernameListRefresh();
  const [form, setForm] = useState<SeasonalScoresForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SeasonalScoresResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const shows = await fetchUserSeasonalShows(
        username,
        controller.signal,
        forceRefresh ? { forceRefresh: true } : undefined,
      );
      setResult(buildSeasonalColumns(shows, form));
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
        <label className="tool-field tool-field-label-row tool-field-username">
          <span className="tool-field-label">AniList username</span>
          <input
            className="slot-search anime-to-anime-endpoint-user-input"
            type="text"
            disabled={running}
            placeholder="AL Username"
            value={form.username}
            title="AniList username — right-click to re-fetch list from AniList"
            onChange={(e) => patchForm({ username: e.target.value })}
            onContextMenu={(e) => onUsernameContextMenu(e, form.username, running)}
          />
        </label>

        <label className="tool-field">
          <span className="tool-field-label">
            Seasons (one per line: <code>all</code>, <code>allseasons</code> (full range, split by seasons),{' '}
            <code>Winter 2024</code>, <code>2018</code>)
          </span>
          <textarea
            className="tool-textarea csv-textarea"
            rows={4}
            disabled={running}
            value={form.seasonText}
            onChange={(e) => patchForm({ seasonText: e.target.value })}
            placeholder={'Winter 2024\nSpring 2024\nSummer 2024'}
          />
        </label>

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
        {usernameHint && <p className="tool-field-hint">{usernameHint}</p>}
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
