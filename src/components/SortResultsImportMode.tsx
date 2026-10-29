import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import {
  annotateSlotCompletion,
  getAuthState,
  listCloudSlots,
  pullSlot,
  type CloudSlotMeta,
} from '../lib/cloud';
import {
  applySlotImportEdits,
  applySlotImportItemOverride,
  classifyCloudSlotImport,
  cloudSlotImportId,
  effectiveSlotImportItems,
  listSlotImportEntries,
  listSlotImportEntriesFromStorage,
  slotImportOverlayKey,
  slotImportSourceLabel,
  slotImportStatusLabel,
  versionImportsForSlot,
  type SlotImportEntry,
  type SlotImportExcludedRows,
  type SlotImportOverlayMap,
  type SlotRankingImport,
} from '../lib/slotResultsImport';
import { formatSortVersionDate } from '../lib/sortVersions';
import {
  isStatePersistenceAvailable,
  refreshSorterStorageFromIndexedDb,
} from '../lib/storage';
import { STATE_REVISION_KEY } from '../lib/stateStorageDb';
import type { Item, SlotsManifest, SortVersion } from '../lib/types';
import {
  CloudSlotSortControls,
  filterCloudSlotRows,
  persistCloudSlotSortPreference,
  readCloudSlotSortPreference,
  sortCloudSlotRows,
  type CloudSlotSortPreference,
} from './CloudSlotSortControls';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import { RemoveGlyph } from './RemoveGlyph';
import type { StagedGroupInput } from './StagedItemsPanel';

export type OrderedSlotImport = SlotRankingImport;

interface PreparedCloudImport extends OrderedSlotImport {
  asPreRanked: boolean;
}

/** Per-save picked version ids (version-picking variant). */
type VersionPicks = Readonly<Record<string, ReadonlySet<string>>>;
const NO_PICKS: ReadonlySet<string> = new Set();

function toggleVersionPick(
  picks: VersionPicks,
  slotId: string,
  versionId: string,
  on: boolean,
): VersionPicks {
  const next = new Set(picks[slotId]);
  if (on) next.add(versionId);
  else next.delete(versionId);
  return { ...picks, [slotId]: next };
}

/** Checks every version of a save the first time it is selected; later manual picks stick. */
function withAllVersionsPicked(picks: VersionPicks, entry: SlotImportEntry): VersionPicks {
  if (picks[entry.meta.id] !== undefined || !entry.versions?.length) return picks;
  return { ...picks, [entry.meta.id]: new Set(entry.versions.map((v) => v.id)) };
}

/** Picked versions when any are checked; otherwise the save's current ranking. */
function rankingImportsForEntry(
  entry: SlotImportEntry,
  picks: ReadonlySet<string> | undefined,
  source: string,
  slotName: string,
  items: Item[],
): SlotRankingImport[] {
  if (picks?.size) return versionImportsForSlot(entry, picks, source, slotName);
  if (items.length === 0) return [];
  return [
    {
      source,
      slotName,
      items,
      createdAt: entry.meta.updatedAt,
      ...(entry.versions ? { versions: entry.versions } : {}),
    },
  ];
}

const NEW_ORDER_IMPORT_TOOLTIP =
  'Left-click to import into the selected order. Right-click to append as a new order, keep this dialog open, and clear the selection.';

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
  /** Replace the browser-save selection summary with sort and search controls. */
  showBrowserSortControls?: boolean;
  /** App-owned manifest; updates when the asynchronous storage boot completes. */
  browserSaveManifest?: SlotsManifest;
  /**
   * Ordered-import consumers only: saves with recorded versions list them as a
   * checklist, and checked versions import instead of the current ranking.
   */
  pickVersions?: boolean;
  /** With `pickVersions`: selecting a save checks all of its versions. */
  autoPickAllVersions?: boolean;
} & (
  | {
      onAppendToStaged: (groups: StagedGroupInput[]) => void;
      onAddSlotImports?: never;
      onImportOrderedItems?: never;
      onImportOrderedItemsAsNewOrders?: never;
    }
  | {
      onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
      onAppendToStaged?: never;
      onImportOrderedItems?: never;
      onImportOrderedItemsAsNewOrders?: never;
    }
  | {
      onImportOrderedItems: (imports: OrderedSlotImport[]) => void;
      onImportOrderedItemsAsNewOrders?: (imports: OrderedSlotImport[]) => void;
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
  onImportOrderedItemsAsNewOrders,
  embeddedHint,
  selectionMode = 'multiple',
  showBrowserSortControls = false,
  browserSaveManifest,
  pickVersions: pickVersionsProp = false,
  autoPickAllVersions = false,
}: SortResultsImportModeProps) {
  const pickVersions = pickVersionsProp && onImportOrderedItems !== undefined;
  const autoPick = pickVersions && autoPickAllVersions;
  const [versionPicks, setVersionPicks] = useState<VersionPicks>({});
  const [revision, setRevision] = useState(0);
  const [cloudOpen, setCloudOpen] = useState(false);
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
    () => {
      const options = excludeSlotId ? { excludeSlotId } : undefined;
      return browserSaveManifest
        ? listSlotImportEntries(browserSaveManifest, options)
        : listSlotImportEntriesFromStorage(options);
    },
    [browserSaveManifest, excludeSlotId, revision],
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
      const entry = autoPick ? importable.find((e) => e.meta.id === id) : undefined;
      if (entry) setVersionPicks((prev) => withAllVersionsPicked(prev, entry));
    }
    onDraftActivity?.();
  }, [onDraftActivity, selectionMode, autoPick, importable]);

  const selectAllImportable = useCallback(() => {
    setSelected(new Set(importable.map((e) => e.meta.id)));
    if (autoPick) {
      setVersionPicks((prev) => importable.reduce(withAllVersionsPicked, prev));
    }
    setAsPreRanked((prev) => {
      const next = { ...prev };
      for (const e of importable) {
        if (next[e.meta.id] === undefined) next[e.meta.id] = true;
      }
      return next;
    });
    onDraftActivity?.();
  }, [importable, onDraftActivity, autoPick]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const orderedImportsFor = useCallback(
    (entry: SlotImportEntry): SlotRankingImport[] =>
      rankingImportsForEntry(
        entry,
        pickVersions ? versionPicks[entry.meta.id] : undefined,
        slotImportSourceLabel(entry.meta),
        entry.meta.name,
        effectiveItemsForEntry(entry),
      ),
    [pickVersions, versionPicks, effectiveItemsForEntry],
  );

  const addableCount = useMemo(() => {
    let total = 0;
    for (const entry of selectedImportable) {
      total += pickVersions
        ? orderedImportsFor(entry).reduce((n, imp) => n + imp.items.length, 0)
        : effectiveItemsForEntry(entry).length;
    }
    return total;
  }, [selectedImportable, effectiveItemsForEntry, orderedImportsFor, pickVersions]);

  const toggleVersion = useCallback(
    (slotId: string, versionId: string, on: boolean) => {
      setVersionPicks((prev) => toggleVersionPick(prev, slotId, versionId, on));
      if (on) toggleSelected(slotId, true);
      onDraftActivity?.();
    },
    [toggleSelected, onDraftActivity],
  );

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
        payload.hydratedItem !== undefined ||
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
        if (payload.hydratedItem !== undefined) {
          updated.replacement = payload.hydratedItem;
        }
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
          updated.replacement === undefined &&
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

  function handleAdd(asNewOrders = false): void {
    if (selectedImportable.length === 0 || addableCount === 0) return;

    if (onImportOrderedItems) {
      const importOrderedItems = asNewOrders
        ? onImportOrderedItemsAsNewOrders
        : onImportOrderedItems;
      if (!importOrderedItems) return;
      const imports = selectedImportable
        .flatMap(orderedImportsFor)
        .filter((entry) => entry.items.length > 0);
      if (imports.length > 0) {
        importOrderedItems(imports);
        setSelected(new Set());
        setExpandedId(null);
        setOverrides(new Map());
        setExcluded(new Set());
        setVersionPicks({});
      }
      if (!asNewOrders) onComplete?.();
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

  const handleCloudImports = useCallback(
    (imports: PreparedCloudImport[], asNewOrders = false) => {
      if (imports.length === 0) return;
      if (onImportOrderedItems) {
        const importOrderedItems = asNewOrders
          ? onImportOrderedItemsAsNewOrders
          : onImportOrderedItems;
        if (!importOrderedItems) return;
        importOrderedItems(
          imports.map(({ asPreRanked: _asPreRanked, ...rest }) => rest),
        );
      } else if (onAppendToStaged) {
        onAppendToStaged(
          imports.map(({ source, items, asPreRanked }) => ({
            kind: asPreRanked ? 'sublist' : 'flat',
            source,
            items,
          })),
        );
      } else {
        onAddSlotImports!(
          imports.map(({ items, asPreRanked }) => ({ items, asPreRanked })),
        );
      }
      if (!asNewOrders) {
        setCloudOpen(false);
        onComplete?.();
      }
    },
    [
      onImportOrderedItems,
      onImportOrderedItemsAsNewOrders,
      onAppendToStaged,
      onAddSlotImports,
      onComplete,
    ],
  );

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

  const renderBrowserEntry = (entry: SlotImportEntry): ReactNode => (
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
        setExpandedId((id) => (id === entry.meta.id ? null : entry.meta.id))
      }
      onTogglePreRanked={(value) => setSlotPreRanked(entry.meta.id, value)}
      onEditItem={openEdit}
      onRemoveItem={removePreviewItem}
      versionPicks={pickVersions ? (versionPicks[entry.meta.id] ?? NO_PICKS) : undefined}
      onToggleVersion={(versionId, on) => toggleVersion(entry.meta.id, versionId, on)}
    />
  );

  const description = (
    <>
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
    </>
  );

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

  if (cloudOpen) {
    return (
      <div className={embedded ? 'sort-results-import-embedded' : 'page-section'}>
        {description}
        <CloudResultsPicker
          excludeSlotId={excludeSlotId}
          existingIds={existingIds}
          hiddenRestoreIds={hiddenRestoreIds}
          showPreRankedToggle={showPreRankedToggle}
          selectionMode={selectionMode}
          pickVersions={pickVersions}
          autoPickAllVersions={autoPick}
          onDraftActivity={onDraftActivity}
          onBack={() => setCloudOpen(false)}
          onImport={handleCloudImports}
          onImportAsNewOrders={
            onImportOrderedItemsAsNewOrders
              ? (imports) => handleCloudImports(imports, true)
              : undefined
          }
        />
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
      {description}

      <div className="sort-results-import-toolbar">
        <span className="sort-results-import-summary">
          Saved in this browser
        </span>
        <div className="sort-results-import-toolbar-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setCloudOpen(true)}
          >
            Google Drive…
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="csv-hint">No saved slots yet.</p>
      ) : showBrowserSortControls ? (
        <SortableBrowserSaveResults
          entries={entries}
          renderEntry={renderBrowserEntry}
        />
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
                onTogglePreRanked={(value) =>
                  setSlotPreRanked(entry.meta.id, value)
                }
                onEditItem={openEdit}
                onRemoveItem={removePreviewItem}
                versionPicks={
                  pickVersions ? (versionPicks[entry.meta.id] ?? NO_PICKS) : undefined
                }
                onToggleVersion={(versionId, on) =>
                  toggleVersion(entry.meta.id, versionId, on)
                }
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
          title={
            onImportOrderedItemsAsNewOrders
              ? NEW_ORDER_IMPORT_TOOLTIP
              : undefined
          }
          onClick={() => handleAdd()}
          onContextMenu={
            onImportOrderedItemsAsNewOrders
              ? (event) => {
                  event.preventDefault();
                  handleAdd(true);
                }
              : undefined
          }
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

function SortableBrowserSaveResults({
  entries,
  renderEntry,
}: {
  entries: SlotImportEntry[];
  renderEntry: (entry: SlotImportEntry) => ReactNode;
}) {
  const [sortPreference, setSortPreference] =
    useState<CloudSlotSortPreference>(readCloudSlotSortPreference);
  const [searchQuery, setSearchQuery] = useState('');
  const metadata = (entry: SlotImportEntry) => ({
    displayName: entry.meta.name,
    updatedAt: entry.meta.updatedAt,
  });
  const displayedEntries = useMemo(
    () =>
      sortCloudSlotRows(
        filterCloudSlotRows(entries, metadata, searchQuery),
        metadata,
        sortPreference,
      ),
    [entries, searchQuery, sortPreference],
  );

  function changeSortPreference(preference: CloudSlotSortPreference): void {
    setSortPreference(preference);
    persistCloudSlotSortPreference(preference);
  }

  return (
    <>
      <CloudSlotSortControls
        preference={sortPreference}
        searchQuery={searchQuery}
        onChange={changeSortPreference}
        onSearchQueryChange={setSearchQuery}
        ariaLabel="Browser save sorting"
        searchAriaLabel="Search browser saves by name"
      />
      <ul className="sort-results-import-list" role="list">
        {displayedEntries.map(renderEntry)}
      </ul>
      {displayedEntries.length === 0 && (
        <p className="csv-hint">
          No browser saves match “{searchQuery.trim()}”.
        </p>
      )}
    </>
  );
}

type CloudPickerRow = {
  meta: CloudSlotMeta;
  phase: 'ready' | 'loading' | 'loaded' | 'in_progress' | 'failed';
  entry?: SlotImportEntry;
  error?: string;
  warning?: string;
};

function CloudResultsPicker({
  excludeSlotId,
  existingIds,
  hiddenRestoreIds,
  showPreRankedToggle,
  selectionMode,
  pickVersions,
  autoPickAllVersions,
  onDraftActivity,
  onBack,
  onImport,
  onImportAsNewOrders,
}: {
  excludeSlotId?: string;
  existingIds?: Set<string>;
  hiddenRestoreIds?: Set<string>;
  showPreRankedToggle: boolean;
  selectionMode: 'multiple' | 'single';
  pickVersions: boolean;
  autoPickAllVersions: boolean;
  onDraftActivity?: () => void;
  onBack: () => void;
  onImport: (imports: PreparedCloudImport[]) => void;
  onImportAsNewOrders?: (imports: PreparedCloudImport[]) => void;
}) {
  const [versionPicks, setVersionPicks] = useState<VersionPicks>({});
  const [rows, setRows] = useState<CloudPickerRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<CloudSlotSortPreference>(
    readCloudSlotSortPreference,
  );
  const [searchQuery, setSearchQuery] = useState('');
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
    let cancelled = false;
    const auth = getAuthState();
    if (auth.status !== 'signed-in') {
      setAuthMessage('Sign in to Google Drive from Settings first.');
      setRows([]);
      return () => {
        cancelled = true;
      };
    }
    if (!auth.folderId) {
      setAuthMessage('Choose a Google Drive backup folder from Settings first.');
      setRows([]);
      return () => {
        cancelled = true;
      };
    }
    void listCloudSlots()
      .then((slots) => {
        if (cancelled) return;
        const visible = slots.filter(
          (slot) =>
            excludeSlotId === undefined || slot.sorterSlotId !== excludeSlotId,
        );
        setRows(
          visible.map((meta) => ({
            meta,
            phase: meta.done === false ? 'in_progress' : 'ready',
          })),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListError(
          error instanceof Error ? error.message : 'Could not list Drive slots.',
        );
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [excludeSlotId]);

  const sortedRows = useMemo(
    () =>
      rows === null
        ? null
        : sortCloudSlotRows(
            filterCloudSlotRows(rows, (row) => row.meta, searchQuery),
            (row) => row.meta,
            sortPreference,
          ),
    [rows, searchQuery, sortPreference],
  );

  function changeSortPreference(preference: CloudSlotSortPreference): void {
    setSortPreference(preference);
    persistCloudSlotSortPreference(preference);
  }

  const loadedEntries = useMemo(
    () =>
      (rows ?? [])
        .map((row) => row.entry)
        .filter((entry): entry is SlotImportEntry => entry !== undefined),
    [rows],
  );
  const selectedEntries = useMemo(
    () =>
      loadedEntries.filter(
        (entry) =>
          entry.status === 'importable' && selected.has(entry.meta.id),
      ),
    [loadedEntries, selected],
  );

  const effectiveItemsForEntry = useCallback(
    (entry: SlotImportEntry): Item[] => {
      if (!entry.items) return [];
      return effectiveSlotImportItems(
        entry.meta.id,
        entry.items,
        overrides,
        excluded,
        existingIds,
        hiddenRestoreIds,
      );
    },
    [overrides, excluded, existingIds, hiddenRestoreIds],
  );

  const rowNameFor = useCallback(
    (entry: SlotImportEntry): string => {
      const cloudId = entry.meta.id.slice('cloud:'.length);
      return rows?.find((row) => row.meta.cloudId === cloudId)?.meta.displayName ?? entry.meta.name;
    },
    [rows],
  );

  const orderedImportsFor = useCallback(
    (entry: SlotImportEntry): SlotRankingImport[] => {
      const name = rowNameFor(entry);
      return rankingImportsForEntry(
        entry,
        pickVersions ? versionPicks[entry.meta.id] : undefined,
        `Cloud sort: ${name}`,
        name,
        effectiveItemsForEntry(entry),
      );
    },
    [rowNameFor, pickVersions, versionPicks, effectiveItemsForEntry],
  );

  const addableCount = useMemo(
    () =>
      selectedEntries.reduce(
        (count, entry) =>
          count +
          orderedImportsFor(entry).reduce((n, imp) => n + imp.items.length, 0),
        0,
      ),
    [selectedEntries, orderedImportsFor],
  );

  const toggleSelected = useCallback(
    (id: string, on: boolean) => {
      setSelected((prev) =>
        updateSortResultSelection(prev, id, on, selectionMode),
      );
      if (on) {
        setAsPreRanked((prev) =>
          prev[id] === undefined ? { ...prev, [id]: true } : prev,
        );
        const entry = autoPickAllVersions
          ? loadedEntries.find((e) => e.meta.id === id)
          : undefined;
        if (entry) setVersionPicks((prev) => withAllVersionsPicked(prev, entry));
      }
      onDraftActivity?.();
    },
    [onDraftActivity, selectionMode, autoPickAllVersions, loadedEntries],
  );

  const loadCloudSlot = useCallback(
    async (meta: CloudSlotMeta) => {
      setRows((current) =>
        current?.map((row) =>
          row.meta.cloudId === meta.cloudId
            ? { ...row, phase: 'loading', error: undefined }
            : row,
        ) ?? null,
      );
      try {
        const pulled = await pullSlot(meta.cloudId);
        const bodyDone = pulled.blob.progress.done === true;
        let warning: string | undefined;
        if (meta.done !== bodyDone) {
          try {
            await annotateSlotCompletion(meta.cloudId, bodyDone);
          } catch (error: unknown) {
            const detail =
              error instanceof Error ? error.message : 'metadata update failed';
            warning = `Loaded, but completion metadata could not be updated: ${detail}`;
          }
        }

        const entry = classifyCloudSlotImport(meta, pulled.blob);
        const id = cloudSlotImportId(meta.cloudId);
        setRows((current) =>
          current?.map((row) =>
            row.meta.cloudId === meta.cloudId
              ? {
                  ...row,
                  meta: { ...row.meta, done: bodyDone },
                  phase: bodyDone ? 'loaded' : 'in_progress',
                  entry,
                  warning,
                }
              : row,
          ) ?? null,
        );
        if (entry.status === 'importable') {
          // The freshly pulled entry is not in `loadedEntries` yet.
          if (autoPickAllVersions) {
            setVersionPicks((prev) => withAllVersionsPicked(prev, entry));
          }
          toggleSelected(id, true);
        }
      } catch (error: unknown) {
        setRows((current) =>
          current?.map((row) =>
            row.meta.cloudId === meta.cloudId
              ? {
                  ...row,
                  phase: 'failed',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Could not load this Drive slot.',
                }
              : row,
          ) ?? null,
        );
      }
    },
    [toggleSelected, autoPickAllVersions],
  );

  const buildOtherIds = useCallback(
    (slotId: string, index: number, currentId: string): Map<string, string> => {
      const otherIds = new Map<string, string>();
      for (const entry of loadedEntries) {
        if (!entry.items) continue;
        entry.items.forEach((item, itemIndex) => {
          const key = slotImportOverlayKey(entry.meta.id, itemIndex);
          if (excluded.has(key)) return;
          const effective = applySlotImportItemOverride(
            item,
            overrides.get(key),
          );
          if (entry.meta.id === slotId && itemIndex === index) return;
          if (effective.id === currentId) return;
          otherIds.set(effective.id, effective.label);
        });
      }
      return otherIds;
    },
    [loadedEntries, excluded, overrides],
  );

  const openEdit = useCallback(
    (slotId: string, index: number) => {
      const entry = loadedEntries.find((candidate) => candidate.meta.id === slotId);
      const item = entry?.items?.[index];
      if (!item) return;
      const effective = applySlotImportItemOverride(
        item,
        overrides.get(slotImportOverlayKey(slotId, index)),
      );
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
    [loadedEntries, overrides, buildOtherIds],
  );

  const removePreviewItem = useCallback(
    (slotId: string, index: number) => {
      setExcluded((current) => {
        const next = new Set(current);
        next.add(slotImportOverlayKey(slotId, index));
        return next;
      });
      onDraftActivity?.();
    },
    [onDraftActivity],
  );

  const saveEdit = useCallback(
    (payload: EditItemSavePayload) => {
      if (!editTarget) return;
      const key = slotImportOverlayKey(editTarget.slotId, editTarget.index);
      setOverrides((current) => {
        const next = new Map(current);
        const updated = { ...(next.get(key) ?? {}) };
        if (payload.hydratedItem !== undefined) {
          updated.replacement = payload.hydratedItem;
        }
        if (payload.label !== undefined) updated.label = payload.label;
        if (payload.id !== undefined) updated.id = payload.id;
        if (payload.url !== undefined) updated.url = payload.url;
        if (payload.imageUrl !== undefined) updated.imageUrl = payload.imageUrl;
        next.set(key, updated);
        return next;
      });
      setEditTarget(null);
      onDraftActivity?.();
    },
    [editTarget, onDraftActivity],
  );

  const buildPreparedImports = useCallback(
    (): PreparedCloudImport[] =>
      selectedEntries.flatMap((entry) =>
        orderedImportsFor(entry)
          .filter((imp) => imp.items.length > 0)
          .map((imp) => ({
            ...imp,
            asPreRanked:
              showPreRankedToggle && (asPreRanked[entry.meta.id] ?? true),
          })),
      ),
    [selectedEntries, orderedImportsFor, showPreRankedToggle, asPreRanked],
  );

  const toggleVersion = useCallback(
    (slotId: string, versionId: string, on: boolean) => {
      setVersionPicks((prev) => toggleVersionPick(prev, slotId, versionId, on));
      if (on) toggleSelected(slotId, true);
      onDraftActivity?.();
    },
    [toggleSelected, onDraftActivity],
  );

  const submit = useCallback(() => {
    onImport(buildPreparedImports());
  }, [buildPreparedImports, onImport]);

  const editStubItem: Item | null = editTarget
    ? {
        id: editTarget.currentId,
        label: editTarget.currentLabel,
        url: editTarget.currentUrl,
        imageUrl: editTarget.currentImageUrl,
      }
    : null;

  return (
    <>
      <div className="sort-results-import-toolbar">
        <span className="sort-results-import-summary">Google Drive slots</span>
        <button type="button" className="btn btn-sm" onClick={onBack}>
          Back to browser saves
        </button>
      </div>
      <p className="csv-hint">
        Drive files are downloaded only when you choose Load. They are imported
        temporarily and are not copied into a browser save slot.
      </p>
      <CloudSlotSortControls
        preference={sortPreference}
        searchQuery={searchQuery}
        onChange={changeSortPreference}
        onSearchQueryChange={setSearchQuery}
      />
      {rows === null && <p className="csv-hint">Loading Google Drive…</p>}
      {authMessage && <p className="csv-hint">{authMessage}</p>}
      {listError && <p className="error-text">{listError}</p>}
      {rows?.length === 0 && !authMessage && !listError && (
        <p className="csv-hint">No sorter slots found in this Drive folder.</p>
      )}
      {sortedRows && sortedRows.length > 0 && (
        <ul className="sort-results-import-list" role="list">
          {sortedRows.map((row) => {
            if (row.entry && row.phase === 'loaded') {
              const id = row.entry.meta.id;
              return (
                <SlotImportRow
                  key={row.meta.cloudId}
                  entry={row.entry}
                  selected={selected.has(id)}
                  expanded={expandedId === id}
                  asPreRanked={asPreRanked[id] ?? true}
                  showPreRankedToggle={showPreRankedToggle}
                  existingIds={existingIds}
                  hiddenRestoreIds={hiddenRestoreIds}
                  overrides={overrides}
                  excluded={excluded}
                  selectionMode={selectionMode}
                  warning={row.warning}
                  onToggleSelect={(on) => toggleSelected(id, on)}
                  onToggleExpand={() =>
                    setExpandedId((current) => (current === id ? null : id))
                  }
                  onTogglePreRanked={(value) =>
                    setAsPreRanked((current) => ({
                      ...current,
                      [id]: value,
                    }))
                  }
                  onEditItem={openEdit}
                  onRemoveItem={removePreviewItem}
                  versionPicks={pickVersions ? (versionPicks[id] ?? NO_PICKS) : undefined}
                  onToggleVersion={(versionId, on) => toggleVersion(id, versionId, on)}
                />
              );
            }
            const disabled =
              row.phase === 'loading' || row.phase === 'in_progress';
            const status =
              row.phase === 'loading'
                ? 'loading and validating…'
                : row.phase === 'in_progress'
                  ? 'in progress — not importable'
                  : row.phase === 'failed'
                    ? row.error ?? 'could not load'
                    : row.meta.done === true
                      ? 'completed · ready to load'
                      : 'legacy save · completion unknown';
            return (
              <li
                key={row.meta.cloudId}
                className={[
                  'sort-results-import-row',
                  disabled ? 'sort-results-import-row--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="sort-results-import-row-main">
                  <div className="sort-results-import-row-body">
                    <div className="sort-results-import-row-title">
                      {row.meta.displayName}
                    </div>
                    <div className="sort-results-import-row-meta">{status}</div>
                  </div>
                  {!disabled && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void loadCloudSlot(row.meta)}
                    >
                      {row.meta.done === true ? 'Load' : 'Check & load'}
                    </button>
                  )}
                </div>
                {row.warning && <p className="error-text">{row.warning}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {rows && rows.length > 0 && sortedRows?.length === 0 && (
        <p className="csv-hint">No Drive slots match “{searchQuery.trim()}”.</p>
      )}
      <div className="sort-results-import-footer">
        <button
          type="button"
          className="btn primary"
          disabled={addableCount < 1}
          title={onImportAsNewOrders ? NEW_ORDER_IMPORT_TOOLTIP : undefined}
          onClick={submit}
          onContextMenu={
            onImportAsNewOrders
              ? (event) => {
                  event.preventDefault();
                  const imports = buildPreparedImports();
                  if (imports.length > 0) {
                    onImportAsNewOrders(imports);
                    setSelected(new Set());
                    setExpandedId(null);
                    setOverrides(new Map());
                    setExcluded(new Set());
                    setVersionPicks({});
                  }
                }
              : undefined
          }
        >
          Import from Drive ({addableCount})
        </button>
      </div>
      {editTarget && editStubItem && (
        <EditItemModal
          item={editStubItem}
          allowEditId
          currentId={editTarget.currentId}
          otherIds={editTarget.otherIds}
          onCancel={() => setEditTarget(null)}
          onSave={saveEdit}
        />
      )}
    </>
  );
}

function SlotVersionChecklist({
  slotId,
  versions,
  picks,
  onToggle,
}: {
  slotId: string;
  versions: readonly SortVersion[];
  picks: ReadonlySet<string>;
  onToggle: (versionId: string, on: boolean) => void;
}) {
  const newestFirst = [...versions].reverse();
  return (
    <fieldset
      className="sort-results-import-versions"
      onClick={(e) => e.stopPropagation()}
    >
      <legend className="header-hint">
        {picks.size > 0
          ? `${picks.size} version${picks.size === 1 ? '' : 's'} selected — each imports in date order`
          : 'Versions — none checked imports the current ranking'}
      </legend>
      {newestFirst.map((version) => {
        const inputId = `sort-import-version-${slotId}-${version.id}`;
        return (
          <div key={version.id} className="checkbox-row">
            <input
              id={inputId}
              type="checkbox"
              checked={picks.has(version.id)}
              onChange={(e) => onToggle(version.id, e.target.checked)}
            />
            <label htmlFor={inputId}>
              {formatSortVersionDate(version.createdAt, true)} · {version.rankedIds.length} item
              {version.rankedIds.length === 1 ? '' : 's'}
            </label>
          </div>
        );
      })}
    </fieldset>
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
  warning,
  onToggleSelect,
  onToggleExpand,
  onTogglePreRanked,
  onEditItem,
  onRemoveItem,
  versionPicks,
  onToggleVersion,
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
  warning?: string;
  onToggleSelect: (on: boolean) => void;
  onToggleExpand: () => void;
  onTogglePreRanked: (value: boolean) => void;
  onEditItem: (slotId: string, index: number) => void;
  onRemoveItem: (slotId: string, index: number) => void;
  /** Set only in the version-picking variant. */
  versionPicks?: ReadonlySet<string>;
  onToggleVersion?: (versionId: string, on: boolean) => void;
}) {
  const importable = entry.status === 'importable';
  const slotId = entry.meta.id;
  const showVersions =
    importable && versionPicks !== undefined && (entry.versions?.length ?? 0) > 0;

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

      {warning && <p className="error-text">{warning}</p>}

      {showVersions && (selected || expanded) && (
        <SlotVersionChecklist
          slotId={slotId}
          versions={entry.versions!}
          picks={versionPicks!}
          onToggle={(versionId, on) => onToggleVersion?.(versionId, on)}
        />
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
