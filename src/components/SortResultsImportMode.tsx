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
import {
  isStatePersistenceAvailable,
  refreshSorterStorageFromIndexedDb,
} from '../lib/storage';
import { STATE_REVISION_KEY } from '../lib/stateStorageDb';
import type { Item } from '../lib/types';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import { RemoveGlyph } from './RemoveGlyph';
import type { StagedGroupInput } from './StagedItemsPanel';

export interface OrderedSlotImport {
  source: string;
  items: Item[];
}

type SortResultsImportModeProps = {
  embedded?: boolean;
  /**
   * Active slot id — hidden from the picker so users do not import from
   * the sort they are currently editing (disk may lag in-memory state).
   */
  excludeSlotId?: string;
  /** Skip items already in the active sort (AddItemsModal path). */
  existingIds?: Set<string>;
  /** Hidden ids — still importable; add will reinsert. */
  hiddenRestoreIds?: Set<string>;
  /** Merge engine only — pre-ranked toggle is hidden when false. */
  showPreRankedToggle?: boolean;
  onDraftActivity?: () => void;
  /** Called after a successful add (modal closes itself). */
  onComplete?: () => void;
  /** Context-specific copy for embedded consumers outside the sorter. */
  embeddedHint?: string;
  /** Restrict consumers such as Reorder Favourites to one completed slot. */
  selectionMode?: 'multiple' | 'single';
} & (
  | {
      onAppendToStaged: (groups: StagedGroupInput[]) => void;
      onAddSlotImports?: never;
      onImportOrderedItems?: never;
    }
  | {
      onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
      onAppendToStaged?: never;
      onImportOrderedItems?: never;
    }
  | {
      onImportOrderedItems: (imports: OrderedSlotImport[]) => void;
      onAppendToStaged?: never;
      onAddSlotImports?: never;
    }
);

function buildImportBatches(
  entries: SlotImportEntry[],
  asPreRanked: Record<string, boolean>,
  existingIds: Set<string> | undefined,
  hiddenRestoreIds: Set<string> | undefined,
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
      hiddenRestoreIds,
    );
    if (items.length === 0) continue;
    const preRanked =
      showPreRankedToggle && (asPreRanked[entry.meta.id] ?? true);
    batches.push({ items, asPreRanked: preRanked });
  }
  return batches;
}

export function updateSortResultSelection(
  current: ReadonlySet<string>,
  id: string,
  selected: boolean,
  mode: 'multiple' | 'single',
): ReadonlySet<string> {
  if (mode === 'single') {
    return selected ? new Set([id]) : new Set();
  }
  const next = new Set(current);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}

export function SortResultsImportMode({
  embedded = false,
  excludeSlotId,
  existingIds,
  hiddenRestoreIds,
  showPreRankedToggle = true,
  onDraftActivity,
  onComplete,
  onAppendToStaged,
  onAddSlotImports,
  onImportOrderedItems,
  embeddedHint,
  selectionMode = 'multiple',
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
      if (e.key !== STATE_REVISION_KEY || !e.newValue) return;
      try {
        const change = JSON.parse(e.newValue) as { scope?: string };
        if (change.scope !== 'sorter') return;
      } catch {
        return;
      }
      void refreshSorterStorageFromIndexedDb().then(() => {
        setRevision((r) => r + 1);
      });
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
        filterExisting ? hiddenRestoreIds : undefined,
      );
    },
    [overrides, excluded, existingIds, hiddenRestoreIds],
  );

  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((prev) =>
      updateSortResultSelection(prev, id, on, selectionMode),
    );
    if (on) {
      setAsPreRanked((prev) =>
        prev[id] === undefined ? { ...prev, [id]: true } : prev,
      );
    }
    onDraftActivity?.();
  }, [onDraftActivity, selectionMode]);

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

    if (onImportOrderedItems) {
      const imports = selectedImportable
        .map((entry) => ({
          source: slotImportSourceLabel(entry.meta),
          items: effectiveItemsForEntry(entry),
        }))
        .filter((entry) => entry.items.length > 0);
      if (imports.length > 0) {
        onImportOrderedItems(imports);
        setSelected(new Set());
        setExpandedId(null);
        setOverrides(new Map());
        setExcluded(new Set());
      }
      onComplete?.();
      return;
    }

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
      hiddenRestoreIds,
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

  const addLabel = (() => {
    if (onImportOrderedItems) {
      return `Import ranked items (${addableCount})`;
    }
    if (onAppendToStaged) {
      return `Add to staged (${addableCount} item${addableCount === 1 ? '' : 's'})`;
    }
    if (addableCount === 0) {
      return 'Add items';
    }
    if (showPreRankedToggle && selectedImportable.length > 0) {
      const modes = selectedImportable.map(
        (entry) => asPreRanked[entry.meta.id] ?? true,
      );
      const allPreRanked = modes.every(Boolean);
      const allSingletons = modes.every((mode) => !mode);
      if (allPreRanked) {
        const sublistLabel =
          selectedImportable.length === 1 ? 'sublist' : 'sublists';
        return `Add ${addableCount} as pre-ranked ${sublistLabel}`;
      }
      if (allSingletons) {
        return `Add ${addableCount} item${addableCount === 1 ? '' : 's'} (individual entries)`;
      }
    }
    return `Add ${addableCount} item${addableCount === 1 ? '' : 's'}`;
  })();

  if (!isStatePersistenceAvailable()) {
    return (
      <div className={embedded ? 'sort-results-import-embedded' : 'page-section'}>
        {!embedded && <h2>Sort results</h2>}
        <p className="csv-hint">
          Persistent browser storage is unavailable. Download a slot JSON
          backup and use Load save file… instead.
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
            Uncheck “Treat as one pre-ranked sublist” on a save to queue each
            item as its own singleton.
          </p>
        </>
      )}
      {embedded && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          {embeddedHint ??
            'Pick one or more completed saves. Items already in the active sort are skipped; hidden items will be reinserted. Expand a save to edit labels, URLs, or ids before adding.'}
          {!embeddedHint && showPreRankedToggle
            ? ' Uncheck “Treat as one pre-ranked sublist” on a save to queue each item as its own singleton.'
            : null}
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
              {selectionMode === 'multiple' && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={selectAllImportable}
                disabled={importable.length === 0}
              >
                Select all completed
              </button>
              )}
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
                hiddenRestoreIds={hiddenRestoreIds}
                overrides={overrides}
                excluded={excluded}
                selectionMode={selectionMode}
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
  hiddenRestoreIds,
  overrides,
  excluded,
  selectionMode,
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
  hiddenRestoreIds?: Set<string>;
  overrides: SlotImportOverlayMap;
  excluded: SlotImportExcludedRows;
  selectionMode: 'multiple' | 'single';
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
        const willRestore = hiddenRestoreIds?.has(effective.id) === true;
        const skippedBySort =
          existingIds?.has(effective.id) === true && !willRestore;
        return { index, effective, skippedBySort, willRestore };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [entry.items, slotId, overrides, excluded, existingIds, hiddenRestoreIds]);

  const dupCount = useMemo(() => {
    if (!entry.items || !existingIds) return 0;
    return applySlotImportEdits(slotId, entry.items, overrides, excluded).filter(
      (it) =>
        existingIds.has(it.id) && !hiddenRestoreIds?.has(it.id),
    ).length;
  }, [entry.items, slotId, overrides, excluded, existingIds, hiddenRestoreIds]);

  const restoreCount = useMemo(() => {
    if (!entry.items || !hiddenRestoreIds) return 0;
    return applySlotImportEdits(slotId, entry.items, overrides, excluded).filter(
      (it) => hiddenRestoreIds.has(it.id),
    ).length;
  }, [entry.items, slotId, overrides, excluded, hiddenRestoreIds]);

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
          type={selectionMode === 'single' ? 'radio' : 'checkbox'}
          name={selectionMode === 'single' ? 'sort-result-import' : undefined}
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
            {restoreCount > 0 && (
              <span className="sort-results-import-dup-hint">
                {' '}
                · {restoreCount} hidden — will reinsert
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

      {importable && showPreRankedToggle && (selected || expanded) && (
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
            Treat as one pre-ranked sublist (preserve order)
          </label>
          <span className="header-hint">
            {asPreRanked
              ? 'Items merge as a single sorted sublist at the back of the queue.'
              : 'Each item becomes its own singleton sublist.'}
          </span>
        </div>
      )}

      {importable && expanded && entry.items && (
        <ol className="sort-results-import-preview">
          {previewRows.map(({ index, effective, skippedBySort, willRestore }) => (
            <li
              key={`${slotId}:${index}`}
              className={[
                'sort-results-import-preview-item',
                skippedBySort ? 'sort-results-import-preview--dup' : '',
                willRestore ? 'sort-results-import-preview--restore' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="rank">{index + 1}.</span>
              <span className="sort-results-import-preview-label" title={effective.label}>
                {effective.label}
                {willRestore && (
                  <span className="sort-results-import-restore-hint">
                    {' '}
                    (hidden — will reinsert)
                  </span>
                )}
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
                  <RemoveGlyph />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
