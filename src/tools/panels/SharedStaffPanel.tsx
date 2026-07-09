import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  type SharedStaffSection,
} from './sharedStaffLogic';
import { runSharedStaffCompare, type SharedStaffRunProgress } from './sharedStaffApi';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import {
  applyHeaderScrollbarGutter,
  syncTableColumnsByIndex,
} from '../../lib/chartSplitTableSync';
import { useToolsPreferencesRevision } from '../../hooks/useToolsPreferences';
import { getProductionAllRoles } from '../toolsPreferences';

const DEFAULT_FORM: SharedStaffForm = {
  showText: '',
  sortByPopularity: true,
  ignoreRelated: false,
  includeAll: false,
  enableSingleShowMode: false,
  topMatchCount: 5,
};

/**
 * Persist the full Compare form across reloads — textarea contents
 * plus every toggle/number — so reopening the tool restores exactly
 * what the user last had set up. The Clear button below the label
 * still only wipes the textarea (matches the user's mental model of
 * "clear the input box", not "reset all settings").
 *
 * Legacy key {@link LS_LEGACY_QUERY_KEY} held just `showText`; we read
 * it on first load if the new key is missing so we don't lose the
 * user's previously-saved query when this expands.
 */
const LS_KEY = 'anime-tools-shared-staff-form';
/** @deprecated migrated into {@link LS_KEY} */
const LS_LEGACY_QUERY_KEY = 'anime-tools-shared-staff-query';

type PersistedSharedStaffForm = SharedStaffForm;

function clampTopMatchCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_FORM.topMatchCount;
  }
  return Math.min(20, Math.max(1, Math.trunc(value)));
}

function loadForm(): SharedStaffForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSharedStaffForm>;
      return {
        ...DEFAULT_FORM,
        showText: typeof parsed.showText === 'string' ? parsed.showText : '',
        sortByPopularity:
          typeof parsed.sortByPopularity === 'boolean'
            ? parsed.sortByPopularity
            : DEFAULT_FORM.sortByPopularity,
        ignoreRelated:
          typeof parsed.ignoreRelated === 'boolean'
            ? parsed.ignoreRelated
            : DEFAULT_FORM.ignoreRelated,
        includeAll:
          typeof parsed.includeAll === 'boolean'
            ? parsed.includeAll
            : DEFAULT_FORM.includeAll,
        enableSingleShowMode:
          typeof parsed.enableSingleShowMode === 'boolean'
            ? parsed.enableSingleShowMode
            : DEFAULT_FORM.enableSingleShowMode,
        topMatchCount: clampTopMatchCount(parsed.topMatchCount),
      };
    }
    const legacyShowText = localStorage.getItem(LS_LEGACY_QUERY_KEY) ?? '';
    return { ...DEFAULT_FORM, showText: legacyShowText };
  } catch {
    return { ...DEFAULT_FORM };
  }
}

function saveForm(form: SharedStaffForm): void {
  try {
    const persisted: PersistedSharedStaffForm = {
      showText: form.showText,
      sortByPopularity: form.sortByPopularity,
      ignoreRelated: form.ignoreRelated,
      includeAll: form.includeAll,
      enableSingleShowMode: form.enableSingleShowMode,
      topMatchCount: form.topMatchCount,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore quota / SecurityError */
  }
}

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

function StaffCompareSectionTable({
  section,
  shows,
  onOpenMedia,
  onOpenStaff,
}: {
  section: SharedStaffSection;
  shows: Array<{ id: number; title: string; coverImage: string | null }>;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
}) {
  const headerWrapRef = useRef<HTMLDivElement>(null);
  const headerTableRef = useRef<HTMLTableElement>(null);
  const bodyTableRef = useRef<HTMLTableElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);

  const syncTableLayout = useCallback(() => {
    const headerWrap = headerWrapRef.current;
    const bodyScroll = bodyScrollRef.current;
    const headerTable = headerTableRef.current;
    const bodyTable = bodyTableRef.current;
    if (!headerWrap || !bodyScroll || !headerTable || !bodyTable) {
      return;
    }
    applyHeaderScrollbarGutter(headerWrap, bodyScroll);
    syncTableColumnsByIndex(headerTable, bodyTable);
  }, []);

  useLayoutEffect(() => {
    syncTableLayout();
    const bodyScroll = bodyScrollRef.current;
    const bodyTable = bodyTableRef.current;
    if (!bodyScroll) {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncTableLayout();
    });
    observer.observe(bodyScroll);
    if (bodyTable) {
      observer.observe(bodyTable);
    }
    return () => {
      observer.disconnect();
    };
  }, [section.rows, shows, syncTableLayout]);

  const syncHeaderScroll = useCallback(
    (el: HTMLElement) => {
      if (headerWrapRef.current) {
        headerWrapRef.current.scrollLeft = el.scrollLeft;
      }
      syncTableLayout();
    },
    [syncTableLayout],
  );

  return (
    <div className="tool-results tool-table-wrap tool-staff-compare-wrap">
      <div ref={headerWrapRef} className="tool-chart-pinned-header">
        <table ref={headerTableRef} className="tool-result-table tool-staff-compare-table">
          <thead>
            <tr>
              <th className="tool-staff-compare-entity tool-staff-compare-section-th">
                <h3 className="tool-section-title">{section.title}</h3>
              </th>
              {shows.map((show) => (
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
        </table>
      </div>
      <DragScroll
        className="tool-staff-compare-body-scroll"
        scrollRef={bodyScrollRef}
        onUserScroll={syncHeaderScroll}
      >
        <table ref={bodyTableRef} className="tool-result-table tool-staff-compare-table">
          <tbody>
            {section.rows.map((row, idx) => (
              <tr key={`${section.title}-${row.entityId}-${idx}`}>
                <td className="tool-staff-compare-entity">
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
    </div>
  );
}

export function SharedStaffPanel({ onOpenMedia, onOpenStaff }: ToolPanelProps) {
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const toolsPrefsRevision = useToolsPreferencesRevision();
  const [form, setForm] = useState<SharedStaffForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SharedStaffRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SharedStaffResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rebuildSourceRef = useRef<SharedStaffRebuildSource | null>(null);
  // Monotonic generation guard: every new Compare and every relabel start
  // bumps the counter so an older async rebuild can't clobber a newer result.
  const rebuildGenerationRef = useRef(0);

  useEffect(() => {
    const source = rebuildSourceRef.current;
    if (!source) {
      return;
    }
    rebuildGenerationRef.current += 1;
    const gen = rebuildGenerationRef.current;
    void rebuildSharedStaffResult(source)
      .then((rebuilt) => {
        if (rebuildGenerationRef.current === gen) {
          setResult(rebuilt);
        }
      })
      .catch((e) => {
        if (rebuildGenerationRef.current === gen) {
          setError(e instanceof Error ? e.message : 'Failed to relabel results.');
        }
      });
    // toolsPrefsRevision: re-derive sections when the "show all production
    // roles" toggle changes — bundles are unchanged, so reuse rebuildSourceRef.
  }, [displayLabelRevision, toolsPrefsRevision]);

  const patchForm = useCallback((patch: Partial<SharedStaffForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  const onClearShowText = useCallback(() => {
    patchForm({ showText: '' });
  }, [patchForm]);

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

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    rebuildGenerationRef.current += 1;

    setRunning(true);
    setError(null);
    setResult(null);
    rebuildSourceRef.current = null;

    const singleShowActive = shows.length === 1 && form.enableSingleShowMode;

    try {
      const { shows: bundles, singleShowReport, singleShowSource } =
        await runSharedStaffCompare({
        showSearches: shows,
        sortByPopularity: form.sortByPopularity,
        ignoreRelated: singleShowActive ? form.ignoreRelated : false,
        enableSingleShowMode: singleShowActive,
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
      setResult(
        finalizeSharedStaffResult(
          bundles,
          { includeAll: form.includeAll, productionAllRoles: getProductionAllRoles() },
          singleShowReport,
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
  const showCount = parseShowInputs(form.showText).length;
  const singleShowEligible = showCount === 1;
  const singleShowOptionsActive = singleShowEligible && form.enableSingleShowMode;

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Compare studios, production staff, and Japanese voice actors across shows — port
        of <code>compare_staff.py</code>.
      </p>

      <form
        className="tool-form-card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) {
            void onCompare(false);
          }
        }}
      >
        <div className="tool-field">
          <div className="tool-field-label-row tool-field-label-header">
            <span className="tool-field-label">Shows (one per line)</span>
            <button
              type="button"
              className="btn btn-small"
              disabled={running || form.showText.length === 0}
              onClick={onClearShowText}
              title="Clear the textarea"
            >
              Clear
            </button>
          </div>
          <textarea
            className="tool-textarea csv-textarea"
            rows={6}
            value={form.showText}
            disabled={running}
            onChange={(e) => patchForm({ showText: e.target.value })}
            placeholder={'e.g. Steins;Gate\nYour Name'}
          />
        </div>

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
          <label
            className="tool-checkbox"
            title="Show every studio/staff/VA from any show, leaving the cell blank where a show lacks that entity. Off by default — only entities common to every show are listed."
          >
            <input
              type="checkbox"
              checked={form.includeAll}
              disabled={running}
              onChange={(e) => patchForm({ includeAll: e.target.checked })}
            />
            Include all (show blanks)
          </label>
        </div>

        <details className="tool-form-details">
          <summary
            className="tool-form-details-summary"
            title="scan staff filmographies for the most overlapping anime (slow)"
          >
            Single-show Mode
          </summary>
          <div
            className={`tool-form-options-stack${singleShowEligible ? '' : ' tool-form-options-stack-disabled'}`}
          >
            <label
              className="tool-checkbox"
              title={
                singleShowEligible
                  ? 'Scan each production staff member’s filmography for anime with the most staff in common. Can take several minutes.'
                  : 'Enter exactly one show to use single-show mode.'
              }
            >
              <input
                type="checkbox"
                checked={form.enableSingleShowMode}
                disabled={running || !singleShowEligible}
                onChange={(e) => patchForm({ enableSingleShowMode: e.target.checked })}
              />
              Enable Single-show Mode
            </label>
            <label
              className={`tool-checkbox${singleShowOptionsActive ? '' : ' tool-form-options-stack-disabled'}`}
            >
              <input
                type="checkbox"
                checked={form.ignoreRelated}
                disabled={running || !singleShowOptionsActive}
                onChange={(e) => patchForm({ ignoreRelated: e.target.checked })}
              />
              Ignore related shows to avoid sequels and spinoffs
            </label>
            <label
              className={`tool-field tool-field-label-row${singleShowOptionsActive ? '' : ' tool-form-options-stack-disabled'}`}
            >
              <span className="tool-field-label">Top matches</span>
              <input
                className="slot-search tool-input-narrow"
                type="number"
                min={1}
                max={20}
                disabled={running || !singleShowOptionsActive}
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

      {result?.kind === 'compare' && (
        <div className="tool-chart-fullbleed">
          {result.sections.map((section) => (
            <StaffCompareSectionTable
              key={section.title}
              section={section}
              shows={result.shows}
              onOpenMedia={onOpenMedia}
              onOpenStaff={onOpenStaff}
            />
          ))}
        </div>
      )}
    </section>
  );
}
