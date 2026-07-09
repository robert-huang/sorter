import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import {
  filterItemsNotInSort,
  listSlotImportEntriesFromStorage,
  slotImportSourceLabel,
  slotImportStatusLabel,
  type SlotImportEntry,
} from '../lib/slotResultsImport';
import { isAutosaveAvailable, MANIFEST_KEY } from '../lib/storage';
import type { StagedGroupInput } from './StagedItemsPanel';

type SortResultsImportModeProps = {
  embedded?: boolean;
  /**
   * Active slot id — hidden from the picker so users do not import from
   * the sort they are currently editing (disk may lag in-memory state).
   */
  excludeSlotId?: string;
  /** Skip items already in the active sort (AddItemsModal path). */
  existingIds?: Set<string>;
  /** Merge engine only — pre-ranked toggle is hidden when false. */
  showPreRankedToggle?: boolean;
  onDraftActivity?: () => void;
  /** Called after a successful add (modal closes itself). */
  onComplete?: () => void;
} & (
  | {
      onAppendToStaged: (groups: StagedGroupInput[]) => void;
      onAddSlotImports?: never;
    }
  | {
      onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
      onAppendToStaged?: never;
    }
);

function buildImportBatches(
  entries: SlotImportEntry[],
  asPreRanked: Record<string, boolean>,
  existingIds: Set<string> | undefined,
  showPreRankedToggle: boolean,
): SlotResultsImportBatch[] {
  const batches: SlotResultsImportBatch[] = [];
  for (const entry of entries) {
    if (!entry.items) continue;
    const items = filterItemsNotInSort(entry.items, existingIds);
    if (items.length === 0) continue;
    const preRanked =
      showPreRankedToggle && (asPreRanked[entry.meta.id] ?? true);
    batches.push({ items, asPreRanked: preRanked });
  }
  return batches;
}

export function SortResultsImportMode({
  embedded = false,
  excludeSlotId,
  existingIds,
  showPreRankedToggle = true,
  onDraftActivity,
  onComplete,
  onAppendToStaged,
  onAddSlotImports,
}: SortResultsImportModeProps) {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [asPreRanked, setAsPreRanked] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (!e.key || e.key === MANIFEST_KEY || e.key.startsWith('sorter:slot:')) {
        setRevision((r) => r + 1);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const entries = useMemo(
    () =>
      listSlotImportEntriesFromStorage(
        excludeSlotId ? { excludeSlotId } : undefined,
      ),
    [excludeSlotId, revision],
  );

  const importable = useMemo(
    () => entries.filter((e) => e.status === 'importable'),
    [entries],
  );

  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    if (on) {
      setAsPreRanked((prev) =>
        prev[id] === undefined ? { ...prev, [id]: true } : prev,
      );
    }
    onDraftActivity?.();
  }, [onDraftActivity]);

  const selectAllImportable = useCallback(() => {
    setSelected(new Set(importable.map((e) => e.meta.id)));
    setAsPreRanked((prev) => {
      const next = { ...prev };
      for (const e of importable) {
        if (next[e.meta.id] === undefined) next[e.meta.id] = true;
      }
      return next;
    });
    onDraftActivity?.();
  }, [importable, onDraftActivity]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectedImportable = useMemo(
    () => importable.filter((e) => selected.has(e.meta.id)),
    [importable, selected],
  );

  const addableCount = useMemo(() => {
    let total = 0;
    for (const entry of selectedImportable) {
      if (!entry.items) continue;
      total += filterItemsNotInSort(entry.items, existingIds).length;
    }
    return total;
  }, [selectedImportable, existingIds]);

  function setSlotPreRanked(id: string, value: boolean): void {
    setAsPreRanked((prev) => ({ ...prev, [id]: value }));
    onDraftActivity?.();
  }

  function handleAdd(): void {
    if (selectedImportable.length === 0 || addableCount === 0) return;

    if (onAppendToStaged) {
      const groups: StagedGroupInput[] = [];
      for (const entry of selectedImportable) {
        if (!entry.items) continue;
        const items = filterItemsNotInSort(entry.items, existingIds);
        if (items.length === 0) continue;
        const preRanked = asPreRanked[entry.meta.id] ?? true;
        groups.push({
          kind: preRanked ? 'sublist' : 'flat',
          source: slotImportSourceLabel(entry.meta),
          items,
        });
      }
      if (groups.length > 0) {
        onAppendToStaged(groups);
        setSelected(new Set());
        setExpandedId(null);
      }
      onComplete?.();
      return;
    }

    const batches = buildImportBatches(
      selectedImportable,
      asPreRanked,
      existingIds,
      showPreRankedToggle,
    );
    if (batches.length > 0) onAddSlotImports!(batches);
    onComplete?.();
  }

  const addLabel = onAppendToStaged
    ? `Add to staged (${addableCount} item${addableCount === 1 ? '' : 's'})`
    : `Add ${addableCount} item${addableCount === 1 ? '' : 's'}`;

  if (!isAutosaveAvailable()) {
    return (
      <div className={embedded ? 'sort-results-import-embedded' : 'page-section'}>
        {!embedded && <h2>Sort results</h2>}
        <p className="csv-hint">
          No saved slots — autosave is unavailable on <code>file://</code>.
          Download a slot JSON backup and use Load save file… instead.
        </p>
      </div>
    );
  }

  return (
    <div
      className={[
        embedded ? 'sort-results-import-embedded' : 'page-section',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {!embedded && (
        <>
          <h2>Sort results</h2>
          <p className="csv-hint">
            Import final rankings from completed saves in this browser.
            Combine with clipboard, CSV, or AniList batches in the staged
            panel below.
          </p>
        </>
      )}
      {embedded && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          Pick one or more completed saves. Items already in this sort are
          skipped.
        </p>
      )}

      {entries.length === 0 ? (
        <p className="csv-hint">No saved slots yet.</p>
      ) : (
        <>
          <div className="sort-results-import-toolbar">
            <span className="sort-results-import-summary">
              {importable.length} importable · {selected.size} selected
            </span>
            <div className="sort-results-import-toolbar-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={selectAllImportable}
                disabled={importable.length === 0}
              >
                Select all completed
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={clearSelection}
                disabled={selected.size === 0}
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="sort-results-import-list" role="list">
            {entries.map((entry) => (
              <SlotImportRow
                key={entry.meta.id}
                entry={entry}
                selected={selected.has(entry.meta.id)}
                expanded={expandedId === entry.meta.id}
                asPreRanked={asPreRanked[entry.meta.id] ?? true}
                showPreRankedToggle={showPreRankedToggle}
                existingIds={existingIds}
                onToggleSelect={(on) => toggleSelected(entry.meta.id, on)}
                onToggleExpand={() =>
                  setExpandedId((id) =>
                    id === entry.meta.id ? null : entry.meta.id,
                  )
                }
                onTogglePreRanked={(v) => setSlotPreRanked(entry.meta.id, v)}
              />
            ))}
          </ul>
        </>
      )}

      <div className="sort-results-import-footer">
        <button
          type="button"
          className="btn primary"
          disabled={addableCount < 1}
          onClick={handleAdd}
        >
          {addLabel}
        </button>
      </div>
    </div>
  );
}

function SlotImportRow({
  entry,
  selected,
  expanded,
  asPreRanked,
  showPreRankedToggle,
  existingIds,
  onToggleSelect,
  onToggleExpand,
  onTogglePreRanked,
}: {
  entry: SlotImportEntry;
  selected: boolean;
  expanded: boolean;
  asPreRanked: boolean;
  showPreRankedToggle: boolean;
  existingIds?: Set<string>;
  onToggleSelect: (on: boolean) => void;
  onToggleExpand: () => void;
  onTogglePreRanked: (value: boolean) => void;
}) {
  const importable = entry.status === 'importable';
  const addableCount =
    entry.items && existingIds
      ? filterItemsNotInSort(entry.items, existingIds).length
      : entry.itemCount;
  const dupCount =
    entry.items && existingIds
      ? entry.itemCount - addableCount
      : 0;

  function onRowClick(e: React.MouseEvent): void {
    if (!importable) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, label, a')) return;
    onToggleSelect(!selected);
  }

  function onRowKeyDown(e: React.KeyboardEvent): void {
    if (!importable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleSelect(!selected);
    }
  }

  return (
    <li
      className={[
        'sort-results-import-row',
        selected ? 'sort-results-import-row--selected' : '',
        !importable ? 'sort-results-import-row--disabled' : '',
        importable ? 'sort-results-import-row--clickable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="sort-results-import-row-main"
        role={importable ? 'button' : undefined}
        tabIndex={importable ? 0 : undefined}
        onClick={onRowClick}
        onKeyDown={onRowKeyDown}
      >
        <input
          type="checkbox"
          checked={selected}
          disabled={!importable}
          onChange={(e) => onToggleSelect(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${entry.meta.name}`}
        />
        <div className="sort-results-import-row-body">
          <div className="sort-results-import-row-title">{entry.meta.name}</div>
          <div className="sort-results-import-row-meta">
            {slotImportStatusLabel(entry)}
            {dupCount > 0 && (
              <span className="sort-results-import-dup-hint">
                {' '}
                · {dupCount} already in sort
              </span>
            )}
          </div>
        </div>
        {importable && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Preview'}
          </button>
        )}
      </div>

      {importable && selected && showPreRankedToggle && (
        <div
          className="checkbox-row sort-results-import-mode-row"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            id={`sort-import-preranked-${entry.meta.id}`}
            type="checkbox"
            checked={asPreRanked}
            onChange={(e) => onTogglePreRanked(e.target.checked)}
          />
          <label htmlFor={`sort-import-preranked-${entry.meta.id}`}>
            Pre-ranked list (preserve order)
          </label>
          <span className="header-hint">
            {asPreRanked
              ? 'Merges as one ordered sublist.'
              : 'Each item becomes its own singleton.'}
          </span>
        </div>
      )}

      {importable && expanded && entry.items && (
        <ol className="sort-results-import-preview">
          {entry.items.map((it) => (
            <li
              key={it.id}
              className={
                existingIds?.has(it.id)
                  ? 'sort-results-import-preview--dup'
                  : undefined
              }
            >
              {it.label}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
