import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { fetchUserSeasonalShows } from './seasonalScoresApi';
import {
  buildSeasonalColumns,
  type SeasonalScoresForm,
  type SeasonalScoresResult,
} from './seasonalScoresLogic';

const LS_KEY = 'anime-tools-seasonal-scores-form';

const DEFAULT_FORM: SeasonalScoresForm = {
  username: '',
  seasonText: '',
  skipEmpty: false,
  airingNotesOnly: false,
};

function loadForm(): SeasonalScoresForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return DEFAULT_FORM;
    }
    return { ...DEFAULT_FORM, ...(JSON.parse(raw) as Partial<SeasonalScoresForm>) };
  } catch {
    return DEFAULT_FORM;
  }
}

function saveForm(form: SeasonalScoresForm): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(form));
  } catch {
    /* ignore */
  }
}

export function SeasonalScoresPanel({ onOpenMedia }: ToolPanelProps) {
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

  const onRun = useCallback(async () => {
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
      const shows = await fetchUserSeasonalShows(username, controller.signal);
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
            void onRun();
          }
        }}
      >
        <div className="tool-field-row">
          <label className="tool-field tool-field-grow">
            <span className="tool-field-label">AniList username</span>
            <input
              className="slot-search"
              type="text"
              disabled={running}
              value={form.username}
              onChange={(e) => patchForm({ username: e.target.value })}
            />
          </label>
        </div>

        <label className="tool-field">
          <span className="tool-field-label">
            Seasons (one per line: <code>Winter 2024</code>, <code>2023</code>,{' '}
            <code>all</code>, <code>allseasons</code>)
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
          <button
            type="button"
            className="btn primary"
            disabled={running}
            onClick={() => void onRun()}
          >
            Compare
          </button>
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
        <div className="tool-season-columns">
          <div className="tool-season-header-row">
            {result.columns.map((col) => (
              <div key={col.label} className="tool-season-col-head">
                <div className="tool-season-col-title">{col.label}</div>
                <div className="tool-season-col-avg">
                  avg: {col.average ?? 'N/A'}
                </div>
              </div>
            ))}
          </div>
          <div className="tool-season-body">
            {Array.from({
              length: Math.max(...result.columns.map((c) => c.shows.length), 0),
            }).map((_, rowIdx) => (
              <div key={rowIdx} className="tool-season-row">
                {result.columns.map((col) => {
                  const show = col.shows[rowIdx];
                  return (
                    <div key={`${col.label}-${rowIdx}`} className="tool-season-cell">
                      {show ? (
                        <>
                          <span className="tool-season-score">
                            {show.score ?? '—'}
                          </span>{' '}
                          <button
                            type="button"
                            className="tool-link-btn"
                            onClick={() => onOpenMedia(show.id, show.title)}
                          >
                            {show.title}
                          </button>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
