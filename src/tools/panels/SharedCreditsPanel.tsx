import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import {
  rebuildSharedCreditsResult,
  type SharedCreditsRebuildSource,
} from '../toolsDisplayRelabel';
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
import { SharedCreditsResultsTable } from './sharedCreditsTable';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';

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

export function SharedCreditsPanel({ onOpenMedia, onOpenStaff }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh();
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<SharedCreditsForm>(DEFAULT_FORM);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SharedCreditsRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SharedCreditsResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rebuildSourceRef = useRef<SharedCreditsRebuildSource | null>(null);

  useEffect(() => {
    const source = rebuildSourceRef.current;
    if (!source) {
      return;
    }
    void rebuildSharedCreditsResult(source).then(setResult);
  }, [displayLabelRevision]);

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

  const onCompare = useCallback(async (forceRefresh = false) => {
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
    rebuildSourceRef.current = null;
    setProgress({ phase: 'resolve' });

    try {
      const staffIds = await resolveStaffIds(inputs, form.useIds, controller.signal);
      const { staffNameFields, lists, userMediaIds, usernameMode } =
        await runSharedCreditsCompare({
          staffIds,
          roleMode: form.roleMode,
          usernameInclude: form.usernameInclude,
          usernameExclude: form.usernameExclude,
          signal: controller.signal,
          onProgress: setProgress,
          fetchOptions: forceRefresh ? { forceRefresh: true } : undefined,
        });

      const source: SharedCreditsRebuildSource = {
        staffIds,
        staffNameFields,
        lists,
        roleMode: form.roleMode,
        form,
        userMediaIds,
        usernameMode,
      };
      rebuildSourceRef.current = source;
      setResult(
        buildSharedCreditsResult(
          staffIds,
          staffNameFields,
          lists,
          form,
          userMediaIds,
          usernameMode,
        ),
      );
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
            void onCompare(false);
          }
        }}
      >
        <div className="tool-field">
          <div className="tool-field-label-row tool-field-label-header">
            <span className="tool-field-label">Staff (one per line)</span>
            <label className="tool-checkbox tool-checkbox-header">
              <input
                type="checkbox"
                checked={form.useIds}
                disabled={running}
                onChange={(e) => patchForm({ useIds: e.target.checked })}
              />
              Staff IDs
            </label>
          </div>
          <textarea
            className="tool-textarea csv-textarea"
            rows={6}
            value={form.staffText}
            disabled={running}
            onChange={(e) => patchForm({ staffText: e.target.value })}
            placeholder={'e.g. Kana Hanazawa\nYuki Kaji'}
          />
        </div>

        <div className="tool-shared-credits-role-row">
          <div className="tool-field tool-field-label-row tool-field-inline">
            <span className="tool-field-label" id="shared-credits-role-label">
              Role type
            </span>
            <div
              className="tool-segmented"
              role="group"
              aria-labelledby="shared-credits-role-label"
            >
              <button
                type="button"
                className={form.roleMode === 'voice' ? 'active' : ''}
                disabled={running}
                onClick={() => patchForm({ roleMode: 'voice' })}
              >
                Voice acting
              </button>
              <button
                type="button"
                className={form.roleMode === 'production' ? 'active' : ''}
                disabled={running}
                onClick={() => patchForm({ roleMode: 'production' })}
              >
                Production
              </button>
            </div>
          </div>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.mainRoleOnly}
              disabled={running || form.roleMode === 'production'}
              onChange={(e) => patchForm({ mainRoleOnly: e.target.checked })}
            />
            Main Roles Only
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.diffMode}
              disabled={running}
              onChange={(e) => patchForm({ diffMode: e.target.checked })}
            />
            Differences Only
          </label>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.oldestFirst}
              disabled={running}
              onChange={(e) => patchForm({ oldestFirst: e.target.checked })}
            />
            Oldest First
          </label>
        </div>

        <div className="tool-shared-credits-filters-row">
          <label className="tool-field tool-field-label-row tool-shared-credits-min-shared">
            <span className="tool-field-label">Min Shared</span>
            <input
              className="slot-search tool-shared-credits-min-shared-input"
              type="number"
              min={1}
              disabled={running || form.diffMode}
              value={form.minMatches ?? ''}
              placeholder="all"
              onChange={(e) => {
                const raw = e.target.value.trim();
                patchForm({
                  minMatches: raw === '' ? null : Math.max(1, Number.parseInt(raw, 10) || 1),
                });
              }}
            />
          </label>
          <ToolUsernameField
            label="List Only"
            value={form.usernameInclude}
            disabled={running}
            refreshing={refreshingList}
            onChange={(usernameInclude) => patchForm({ usernameInclude })}
            onRefresh={() => refreshUsernameList(form.usernameInclude, running)}
          />
          <ToolUsernameField
            label="Exclude List"
            value={form.usernameExclude}
            disabled={running}
            refreshing={refreshingList}
            onChange={(usernameExclude) => patchForm({ usernameExclude })}
            onRefresh={() => refreshUsernameList(form.usernameExclude, running)}
          />
        </div>

        <div className="tool-actions">
          <ToolRunButton
            label="Compare"
            running={running}
            onRun={(forceRefresh) => void onCompare(forceRefresh)}
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

      {result?.kind === 'empty' && <p className="tool-empty">{result.message}</p>}

      {result?.kind === 'diff' && (
        <div className="tool-results">
          {result.blocks.map((block) => (
            <div key={block.staffId} className="tool-diff-block">
              <h3 className="tool-diff-title">
                <ToolStaffButton
                  staffId={block.staffId}
                  name={block.staffName}
                  imageUrl={block.staffImage ?? null}
                  onOpenStaff={onOpenStaff}
                  compact
                />
              </h3>
              <ul className="tool-diff-list">
                {block.shows.map((show) => (
                  <li key={show.mediaId}>
                    <ToolShowButton
                      mediaId={show.mediaId}
                      title={show.title}
                      coverImage={show.coverImage}
                      onOpenMedia={onOpenMedia}
                      compact
                    />
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
        <SharedCreditsResultsTable
          staffIds={result.staffIds}
          staffNames={result.staffNames}
          staffImages={result.staffImages}
          rows={result.rows}
          onOpenMedia={onOpenMedia}
          onOpenStaff={onOpenStaff}
        />
      )}
    </section>
  );
}
