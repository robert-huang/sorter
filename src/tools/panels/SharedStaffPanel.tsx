import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import {
  rebuildSharedStaffResult,
  type SharedStaffRebuildSource,
} from '../toolsDisplayRelabel';
import {
  finalizeSharedStaffResult,
  parseShowInputs,
  type SharedStaffForm,
  type SharedStaffResult,
} from './sharedStaffLogic';
import { runSharedStaffCompare, type SharedStaffRunProgress } from './sharedStaffApi';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';

const DEFAULT_FORM: SharedStaffForm = {
  showText: '',
  sortByPopularity: true,
  ignoreRelated: false,
  diffMode: false,
  topMatchCount: 5,
};

function progressLabel(progress: SharedStaffRunProgress | null): string | null {
  if (!progress) {
    return null;
  }
  switch (progress.phase) {
    case 'resolve':
      return `Resolving show ${progress.showIndex}/${progress.showTotal}: ${progress.label}…`;
    case 'load-show':
      return `Loading credits for ${progress.label}…`;
    case 'single-scan':
      return `Scanning staff filmographies (${progress.staffIndex}/${progress.staffTotal}): ${progress.staffName}…`;
    case 'single-top':
      return `Loading top match: ${progress.label}…`;
    default:
      return null;
  }
}

export function SharedStaffPanel({ onOpenMedia, onOpenStaff }: ToolPanelProps) {
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<SharedStaffForm>(DEFAULT_FORM);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SharedStaffRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SharedStaffResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rebuildSourceRef = useRef<SharedStaffRebuildSource | null>(null);

  useEffect(() => {
    const source = rebuildSourceRef.current;
    if (!source) {
      return;
    }
    void rebuildSharedStaffResult(source).then(setResult);
  }, [displayLabelRevision]);

  const patchForm = useCallback((patch: Partial<SharedStaffForm>) => {
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
    const shows = parseShowInputs(form.showText);
    if (shows.length === 0) {
      setError('Enter at least one show title.');
      setResult(null);
      return;
    }
    if (form.diffMode && shows.length < 2) {
      setError('Diff mode needs at least two shows.');
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

    try {
      const { shows: bundles, singleShowReport, singleShowSource } =
        await runSharedStaffCompare({
        showSearches: shows,
        sortByPopularity: form.sortByPopularity,
        ignoreRelated: form.ignoreRelated,
        topMatchCount: form.topMatchCount,
        signal: controller.signal,
        onProgress: setProgress,
        fetchOptions: forceRefresh ? { forceRefresh: true } : undefined,
      });

      rebuildSourceRef.current = {
        bundles,
        form,
        singleShow: singleShowSource,
      };
      setResult(finalizeSharedStaffResult(bundles, form, singleShowReport));
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
  const showCount = parseShowInputs(form.showText).length;
  const singleShowMode = showCount === 1;

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Compare studios, production staff, and Japanese voice actors across shows — port
        of <code>compare_staff.py</code>. One show triggers a slow “most shared staff”
        search.
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
        <label className="tool-field">
          <span className="tool-field-label">Shows (one per line)</span>
          <textarea
            className="tool-textarea csv-textarea"
            rows={6}
            value={form.showText}
            disabled={running}
            onChange={(e) => patchForm({ showText: e.target.value })}
            placeholder={'e.g. Steins;Gate\nYour Name'}
          />
        </label>

        <div className="tool-field-row">
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={form.sortByPopularity}
              disabled={running}
              onChange={(e) => patchForm({ sortByPopularity: e.target.checked })}
            />
            Match by popularity
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
        </div>

        <details
          className="tool-form-details"
          // Keep collapsed by default; user expands when needed.
        >
          <summary
            className="tool-form-details-summary"
            title="When exactly one show is entered, scan each production staff member's filmography for anime with the most staff in common. Can take several minutes."
          >
            Single-show mode
          </summary>
          <div
            className={`tool-form-options-stack${singleShowMode ? '' : ' tool-form-options-stack-disabled'}`}
          >
            <label className="tool-checkbox">
              <input
                type="checkbox"
                checked={form.ignoreRelated}
                disabled={running || !singleShowMode}
                onChange={(e) => patchForm({ ignoreRelated: e.target.checked })}
              />
              Ignore related shows to avoid sequels and spinoffs
            </label>
            <label className="tool-field tool-field-label-row">
              <span className="tool-field-label">Top matches</span>
              <input
                className="slot-search tool-input-narrow"
                type="number"
                min={1}
                max={20}
                disabled={running || !singleShowMode}
                value={form.topMatchCount}
                onChange={(e) =>
                  patchForm({
                    topMatchCount: Math.max(1, Number.parseInt(e.target.value, 10) || 5),
                  })
                }
              />
            </label>
          </div>
        </details>

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

      {result?.kind === 'compare' && result.singleShowReport && (
        <div className="tool-results tool-single-show-report">
          <h3 className="tool-diff-title">
            Shows with most production staff in common with{' '}
            {result.singleShowReport.sourceTitle}
          </h3>
          <ul className="tool-rank-list">
            {result.singleShowReport.topOverall.map((row) => (
              <li key={row.mediaId}>
                <span className="tool-rank-count">{row.sharedStaffCount}</span>
                <ToolShowButton
                  mediaId={row.mediaId}
                  title={row.title}
                  coverImage={row.coverImage}
                  onOpenMedia={onOpenMedia}
                  compact
                />
              </li>
            ))}
          </ul>
          {result.singleShowReport.byCategory.map((block) => (
            <div key={block.label} className="tool-category-block">
              <h4 className="tool-category-title">
                Top {block.label} overlaps with {result.singleShowReport!.sourceTitle}
              </h4>
              <ul className="tool-rank-list">
                {block.matches.map((row) => (
                  <li key={`${block.label}-${row.mediaId}`}>
                    <span className="tool-rank-count">{row.sharedStaffCount}</span>
                    <ToolShowButton
                      mediaId={row.mediaId}
                      title={row.title}
                      coverImage={row.coverImage}
                      onOpenMedia={onOpenMedia}
                      compact
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {result?.kind === 'compare' &&
        result.sections.map((section) => (
          <DragScroll key={section.title} className="tool-results tool-table-wrap">
            <h3 className="tool-section-title">{section.title}</h3>
            <table className="tool-result-table">
              <thead>
                <tr>
                  <th></th>
                  {result.shows.map((show) => (
                    <th key={show.id}>
                      <ToolShowButton
                        mediaId={show.id}
                        title={show.title}
                        coverImage={show.coverImage}
                        onOpenMedia={onOpenMedia}
                        compact
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, idx) => (
                  <tr key={`${section.title}-${row.entityId}-${idx}`}>
                    <td>
                      {row.name ? (
                        row.kind === 'studio' ? (
                          row.name
                        ) : (
                          <ToolStaffButton
                            staffId={row.entityId}
                            name={row.name}
                            imageUrl={row.imageUrl}
                            onOpenStaff={onOpenStaff}
                            compact
                          />
                        )
                      ) : null}
                    </td>
                    {row.cells.map((cell, colIdx) => (
                      <td key={`${idx}-${colIdx}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </DragScroll>
        ))}
    </section>
  );
}
