import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import {
  buildSharedCreditsResult,
  parseStaffInputs,
  type SharedCreditsForm,
  type SharedCreditsResult,
} from './sharedCreditsLogic';
import {
  resolveStaffIds,
  runSharedCreditsCompare,
  type SharedCreditsRunProgress,
} from './sharedCreditsApi';

const LS_KEY = 'anime-tools-shared-credits-form';

const DEFAULT_FORM: SharedCreditsForm = {
  staffText: '',
  useIds: false,
  roleMode: 'voice',
  minMatches: null,
  mainRoleOnly: false,
  usernameInclude: '',
  usernameExclude: '',
  diffMode: false,
  oldestFirst: false,
};

function loadForm(): SharedCreditsForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return DEFAULT_FORM;
    }
    return { ...DEFAULT_FORM, ...(JSON.parse(raw) as Partial<SharedCreditsForm>) };
  } catch {
    return DEFAULT_FORM;
  }
}

function saveForm(form: SharedCreditsForm): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(form));
  } catch {
    /* ignore */
  }
}

function progressLabel(progress: SharedCreditsRunProgress | null): string | null {
  if (!progress) {
    return null;
  }
  switch (progress.phase) {
    case 'resolve':
      return 'Resolving staff…';
    case 'names':
      return 'Loading staff names…';
    case 'roles':
      return `Fetching roles for ${progress.staffName} (${progress.staffIndex}/${progress.staffTotal})…`;
    case 'user-list':
      return 'Loading user list for cross-reference…';
    case 'compare':
      return 'Comparing…';
    default:
      return null;
  }
}

export function SharedCreditsPanel({ onOpenMedia }: ToolPanelProps) {
  const [form, setForm] = useState<SharedCreditsForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SharedCreditsRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SharedCreditsResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  const patchForm = useCallback((patch: Partial<SharedCreditsForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setProgress(null);
  }, []);

  const onCompare = useCallback(async () => {
    const inputs = parseStaffInputs(form.staffText, form.useIds);
    if (inputs.length === 0) {
      setError('Enter at least one staff name or id.');
      setResult(null);
      return;
    }
    if (form.usernameInclude.trim() && form.usernameExclude.trim()) {
      setError('Use either include or exclude username, not both.');
      setResult(null);
      return;
    }
    if (form.diffMode && inputs.length < 2) {
      setError('Diff mode needs at least two staff.');
      setResult(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setResult(null);
    setProgress({ phase: 'resolve' });

    try {
      const staffIds = await resolveStaffIds(inputs, form.useIds, controller.signal);
      const { staffNames, lists, userMediaIds, usernameMode } =
        await runSharedCreditsCompare({
          staffIds,
          roleMode: form.roleMode,
          usernameInclude: form.usernameInclude,
          usernameExclude: form.usernameExclude,
          signal: controller.signal,
          onProgress: setProgress,
        });

      const built = buildSharedCreditsResult(
        staffIds,
        staffNames,
        lists,
        form,
        userMediaIds,
        usernameMode,
      );
      setResult(built);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      setError(e instanceof Error ? e.message : 'Compare failed.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
        setProgress(null);
      }
    }
  }, [form]);

  const statusText = running ? progressLabel(progress) : null;

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Find anime shared between voice actors or production staff — port of{' '}
        <code>compare_vas.py</code>.
      </p>

      <form
        className="tool-form-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) {
            void onCompare();
          }
        }}
      >
        <label className="tool-field">
          <span className="tool-field-label">Staff (one per line or comma-separated)</span>
          <textarea
            className="tool-textarea csv-textarea"
            rows={4}
            value={form.staffText}
            disabled={running}
            onChange={(e) => patchForm({ staffText: e.target.value })}
            placeholder={'e.g. Kana Hanazawa\nYuki Kaji'}
          />
        </label>

        <div className="tool-field-row">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.useIds}
              disabled={running}
              onChange={(e) => patchForm({ useIds: e.target.checked })}
            />
            Input is AniList staff IDs
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.roleMode === 'production'}
              disabled={running}
              onChange={(e) =>
                patchForm({ roleMode: e.target.checked ? 'production' : 'voice' })
              }
            />
            Production roles (default: voice acting)
          </label>
        </div>

        <div className="tool-field-row">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.mainRoleOnly}
              disabled={running}
              onChange={(e) => patchForm({ mainRoleOnly: e.target.checked })}
            />
            Main roles only
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.diffMode}
              disabled={running}
              onChange={(e) => patchForm({ diffMode: e.target.checked })}
            />
            Diff (unique per staff)
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.oldestFirst}
              disabled={running}
              onChange={(e) => patchForm({ oldestFirst: e.target.checked })}
            />
            Oldest first
          </label>
        </div>

        <div className="tool-field-row">
          <label className="tool-field tool-field-inline">
            <span className="tool-field-label">Min shared (blank = all)</span>
            <input
              className="slot-search tool-input-narrow"
              type="number"
              min={1}
              disabled={running || form.diffMode}
              value={form.minMatches ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim();
                patchForm({
                  minMatches: raw === '' ? null : Math.max(1, Number.parseInt(raw, 10) || 1),
                });
              }}
            />
          </label>
          <label className="tool-field tool-field-grow">
            <span className="tool-field-label">Include only on user list</span>
            <input
              className="slot-search"
              type="text"
              disabled={running}
              value={form.usernameInclude}
              onChange={(e) => patchForm({ usernameInclude: e.target.value })}
              placeholder="AniList username"
            />
          </label>
          <label className="tool-field tool-field-grow">
            <span className="tool-field-label">Exclude user list</span>
            <input
              className="slot-search"
              type="text"
              disabled={running}
              value={form.usernameExclude}
              onChange={(e) => patchForm({ usernameExclude: e.target.value })}
              placeholder="AniList username"
            />
          </label>
        </div>

        <div className="tool-actions">
          <button
            type="button"
            className="btn primary"
            disabled={running}
            onClick={() => void onCompare()}
          >
            Compare
          </button>
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {statusText && <p className="tool-status">{statusText}</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result?.kind === 'empty' && <p className="tool-empty">{result.message}</p>}

      {result?.kind === 'diff' && (
        <div className="tool-results">
          {result.blocks.map((block) => (
            <div key={block.staffId} className="tool-diff-block">
              <h3 className="tool-diff-title">{block.staffName}</h3>
              <ul className="tool-diff-list">
                {block.shows.map((show) => (
                  <li key={show.mediaId}>
                    <button
                      type="button"
                      className="tool-link-btn"
                      onClick={() => onOpenMedia(show.mediaId, show.title)}
                    >
                      {show.title}
                    </button>
                    {show.rolesLabel && (
                      <span className="tool-diff-roles"> — {show.rolesLabel}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {result?.kind === 'table' && (
        <div className="tool-results tool-table-wrap">
          <table className="tool-result-table">
            <thead>
              <tr>
                <th>Show</th>
                {result.staffNames.map((name) => (
                  <th key={name}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, idx) => (
                <tr key={`${row.mediaId}-${idx}`}>
                  <td>
                    {row.title ? (
                      <button
                        type="button"
                        className="tool-link-btn"
                        onClick={() => onOpenMedia(row.mediaId, row.title)}
                      >
                        {row.title}
                      </button>
                    ) : null}
                  </td>
                  {row.cells.map((cell, colIdx) => (
                    <td key={`${idx}-${colIdx}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
