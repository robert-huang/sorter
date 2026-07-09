import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import {
  applySlotImportEdits,
  applySlotImportItemOverride,
  effectiveSlotImportItems,
  listSlotImportEntriesFromStorage,
  slotImportOverlayKey,
  slotImportSourceLabel,
  slotImportStatusLabel,
  type SlotImportEntry,
  type SlotImportExcludedRows,
  type SlotImportOverlayMap,
} from '../lib/slotResultsImport';
import { isAutosaveAvailable, MANIFEST_KEY } from '../lib/storage';
import type { Item } from '../lib/types';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
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
  overrides: SlotImportOverlayMap,
  excluded: SlotImportExcludedRows,
): SlotResultsImportBatch[] {
  const batches: SlotResultsImportBatch[] = [];
  for (const entry of entries) {
    if (!entry.items) continue;
    const items = effectiveSlotImportItems(
      entry.meta.id,
      entry.items,
      overrides,
      excluded,
      existingIds,
    );
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
  const [overrides, setOverrides] = useState<SlotImportOverlayMap>(
    () => new Map(),
  );
  const [excluded, setExcluded] = useState<SlotImportExcludedRows>(
    () => new Set(),
  );
  const [editTarget, setEditTarget] = useState<{
    slotId: string;
    index: number;
    currentLabel: string;
    currentId: string;
    currentUrl: string | undefined;
    currentImageUrl: string | undefined;
    otherIds: Map<string, string>;
  } | null>(null);

  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (!e.key || e.key === MANIFEST_KEY || e.key.startsWith('sorter:slot:')) {
        setRevision((r) => r + 1);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Slot blobs can change under us (another tab completes a sort). Drop
  // preview edits so index-keyed overrides never land on wrong rows.
  useEffect(() => {
    setOverrides(new Map());
    setExcluded(new Set());
    setEditTarget(null);
  }, [revision]);

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

  const selectedImportable = useMemo(
    () => importable.filter((e) => selected.has(e.meta.id)),
    [importable, selected],
  );

  const effectiveItemsForEntry = useCallback(
    (entry: SlotImportEntry, filterExisting = true): Item[] => {
      if (!entry.items) return [];
      return effectiveSlotImportItems(
        entry.meta.id,
        entry.items,
        overrides,
        excluded,
        filterExisting ? existingIds : undefined,
      );
    },
    [overrides, excluded, existingIds],
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

  const addableCount = useMemo(() => {
    let total = 0;
    for (const entry of selectedImportable) {
      total += effectiveItemsForEntry(entry).length;
    }
    return total;
  }, [selectedImportable, effectiveItemsForEntry]);

  function setSlotPreRanked(id: string, value: boolean): void {
    setAsPreRanked((prev) => ({ ...prev, [id]: value }));
    onDraftActivity?.();
  }

  const buildOtherIds = useCallback(
    (slotId: string, index: number, currentId: string): Map<string, string> => {
      const otherIds = new Map<string, string>();
      const sources: SlotImportEntry[] = [...selectedImportable];
      const currentEntry = entries.find((e) => e.meta.id === slotId);
      if (currentEntry && !sources.some((e) => e.meta.id === slotId)) {
        sources.push(currentEntry);
      }
      for (const entry of sources) {
        if (!entry.items) continue;
        entry.items.forEach((item, idx) => {
          const key = slotImportOverlayKey(entry.meta.id, idx);
          if (excluded.has(key)) return;
          const effective = applySlotImportItemOverride(
            item,
            overrides.get(key),
          );
          if (entry.meta.id === slotId && idx === index) return;
          if (effective.id === currentId) return;
          otherIds.set(effective.id, effective.label);
        });
      }
      return otherIds;
    },
    [selectedImportable, entries, overrides, excluded],
  );

  const openEdit = useCallback(
    (slotId: string, index: number) => {
      const entry = entries.find((e) => e.meta.id === slotId);
      if (!entry?.items?.[index]) return;
      const item = entry.items[index];
      const key = slotImportOverlayKey(slotId, index);
      const effective = applySlotImportItemOverride(item, overrides.get(key));
      setEditTarget({
        slotId,
        index,
        currentLabel: effective.label,
        currentId: effective.id,
        currentUrl: effective.url,
        currentImageUrl: effective.imageUrl,
        otherIds: buildOtherIds(slotId, index, effective.id),
      });
    },
    [entries, overrides, buildOtherIds],
  );

  const removePreviewItem = useCallback(
    (slotId: string, index: number) => {
      const key = slotImportOverlayKey(slotId, index);
      setExcluded((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      onDraftActivity?.();
    },
    [onDraftActivity],
  );

  const onEditSave = useCallback(
    (payload: EditItemSavePayload) => {
      if (!editTarget) return;
      const key = slotImportOverlayKey(editTarget.slotId, editTarget.index);
      const hasChange =
        (payload.label !== undefined &&
          payload.label !== editTarget.currentLabel) ||
        (payload.id !== undefined && payload.id !== editTarget.currentId) ||
        (payload.url !== undefined &&
          payload.url !== (editTarget.currentUrl ?? '')) ||
        (payload.imageUrl !== undefined &&
          payload.imageUrl !== (editTarget.currentImageUrl ?? ''));
      setOverrides((prev) => {
        const next = new Map(prev);
        const cur = next.get(key) ?? {};
        const updated = { ...cur };
        if (
          payload.label !== undefined &&
          payload.label !== editTarget.currentLabel
        ) {
          updated.label = payload.label;
        }
        if (payload.id !== undefined && payload.id !== editTarget.currentId) {
          updated.id = payload.id;
        }
        if (
          payload.url !== undefined &&
          payload.url !== (editTarget.currentUrl ?? '')
        ) {
          updated.url = payload.url;
        }
        if (
          payload.imageUrl !== undefined &&
          payload.imageUrl !== (editTarget.currentImageUrl ?? '')
        ) {
          updated.imageUrl = payload.imageUrl;
        }
        if (
          updated.label === undefined &&
          updated.id === undefined &&
          updated.url === undefined &&
          updated.imageUrl === undefined
        ) {
          next.delete(key);
        } else {
          next.set(key, updated);
        }
        return next;
      });
      if (hasChange) onDraftActivity?.();
      setEditTarget(null);
    },
    [editTarget, onDraftActivity],
  );

  const editStubItem: Item | null = editTarget
    ? {
        id: editTarget.currentId,
        label: editTarget.currentLabel,
        url: editTarget.currentUrl,
        imageUrl: editTarget.currentImageUrl,
      }
    : null;

  function handleAdd(): void {
    if (selectedImportable.length === 0 || addableCount === 0) return;

    if (onAppendToStaged) {
      const groups: StagedGroupInput[] = [];
      for (const entry of selectedImportable) {
        const items = effectiveItemsForEntry(entry);
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
        setOverrides(new Map());
        setExcluded(new Set());
      }
      onComplete?.();
      return;
    }

    const batches = buildImportBatches(
      selectedImportable,
      asPreRanked,
      existingIds,
      showPreRankedToggle,
      overrides,
      excluded,
    );
    if (batches.length > 0) {
      onAddSlotImports!(batches);
      setOverrides(new Map());
      setExcluded(new Set());
    }
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
            panel below. Expand a save to edit or remove items before adding.
          </p>
        </>
      )}
      {embedded && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          Pick one or more completed saves. Items already in this sort are
          skipped. Expand a save to edit labels, URLs, or ids before adding.
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
                overrides={overrides}
                excluded={excluded}
                onToggleSelect={(on) => toggleSelected(entry.meta.id, on)}
                onToggleExpand={() =>
                  setExpandedId((id) =>
                    id === entry.meta.id ? null : entry.meta.id,
                  )
                }
                onTogglePreRanked={(v) => setSlotPreRanked(entry.meta.id, v)}
                onEditItem={openEdit}
                onRemoveItem={removePreviewItem}
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

      {editStubItem && editTarget && (
        <EditItemModal
          item={editStubItem}
          onCancel={() => setEditTarget(null)}
          onSave={onEditSave}
          allowEditId
          currentId={editTarget.currentId}
          otherIds={editTarget.otherIds}
        />
      )}
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
  overrides,
  excluded,
  onToggleSelect,
  onToggleExpand,
  onTogglePreRanked,
  onEditItem,
  onRemoveItem,
}: {
  entry: SlotImportEntry;
  selected: boolean;
  expanded: boolean;
  asPreRanked: boolean;
  showPreRankedToggle: boolean;
  existingIds?: Set<string>;
  overrides: SlotImportOverlayMap;
  excluded: SlotImportExcludedRows;
  onToggleSelect: (on: boolean) => void;
  onToggleExpand: () => void;
  onTogglePreRanked: (value: boolean) => void;
  onEditItem: (slotId: string, index: number) => void;
  onRemoveItem: (slotId: string, index: number) => void;
}) {
  const importable = entry.status === 'importable';
  const slotId = entry.meta.id;

  const previewRows = useMemo(() => {
    if (!entry.items) return [];
    return entry.items
      .map((item, index) => {
        const key = slotImportOverlayKey(slotId, index);
        if (excluded.has(key)) return null;
        const effective = applySlotImportItemOverride(
          item,
          overrides.get(key),
        );
        const skippedBySort = existingIds?.has(effective.id) === true;
        return { index, effective, skippedBySort };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [entry.items, slotId, overrides, excluded, existingIds]);

  const dupCount = useMemo(() => {
    if (!entry.items || !existingIds) return 0;
    return applySlotImportEdits(slotId, entry.items, overrides, excluded).filter(
      (it) => existingIds.has(it.id),
    ).length;
  }, [entry.items, slotId, overrides, excluded, existingIds]);

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
          {previewRows.map(({ index, effective, skippedBySort }) => (
            <li
              key={`${slotId}:${index}`}
              className={[
                'sort-results-import-preview-item',
                skippedBySort ? 'sort-results-import-preview--dup' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="sort-results-import-preview-label" title={effective.label}>
                {effective.label}
              </span>
              <span className="preview-item-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onEditItem(slotId, index)}
                  title={`Edit "${effective.label}"`}
                  aria-label={`Edit ${effective.label}`}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => onRemoveItem(slotId, index)}
                  title={`Remove "${effective.label}" from import`}
                  aria-label={`Remove ${effective.label}`}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
