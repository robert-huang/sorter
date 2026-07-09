import { getRanking } from './engine';
import {
  isAutosaveAvailable,
  readManifest,
  readSlotBlob,
  type AutosaveBlob,
} from './storage';
import type { Item, SlotMeta, SlotsManifest, SortState } from './types';

export type SlotImportStatus =
  | 'importable'
  | 'in_progress'
  | 'empty'
  | 'unreadable'
  | 'excluded';

export interface SlotImportEntry {
  meta: SlotMeta;
  status: SlotImportStatus;
  /** Visible ranking count when importable; 0 otherwise. */
  itemCount: number;
  /** Populated only when status is `importable`. */
  items: Item[] | null;
}

export interface SlotImportOptions {
  /** Omit the active slot (mid-sort self-import). */
  excludeSlotId?: string;
}

/** Final ranking from a completed slot blob — mirrors RESULT / share link. */
export function extractCompletedRankingItems(blob: AutosaveBlob): Item[] {
  const state = {
    items: blob.items,
    ...blob.progress,
  } as SortState;
  return getRanking(state)
    .map((id) => blob.items[id])
    .filter((it): it is Item => it != null);
}

export function slotImportSourceLabel(meta: SlotMeta): string {
  return `Sort: ${meta.name}`;
}

export function filterItemsNotInSort(
  items: Item[],
  existingIds?: Set<string>,
): Item[] {
  if (!existingIds || existingIds.size === 0) return items;
  return items.filter((it) => !existingIds.has(it.id));
}

/**
 * Pre-staging edit overlay for Sort Results import preview. Keyed by
 * `${slotId}:${index}` where `index` is the item's position in the
 * slot's completed ranking (0-based). Stable across label/id edits —
 * same handle pattern as CSV preview's `sourceName:rowNumber`.
 */
export type SlotImportItemOverride = {
  label?: string;
  id?: string;
  url?: string;
  imageUrl?: string;
};

export type SlotImportOverlayMap = Map<string, SlotImportItemOverride>;
export type SlotImportExcludedRows = Set<string>;

export function slotImportOverlayKey(slotId: string, index: number): string {
  return `${slotId}:${index}`;
}

export function applySlotImportItemOverride(
  item: Item,
  override: SlotImportItemOverride | undefined,
): Item {
  if (!override) return item;
  const next: Item = { ...item };
  if (override.label !== undefined) next.label = override.label;
  if (override.id !== undefined) next.id = override.id;
  if (override.url !== undefined) next.url = override.url || undefined;
  if (override.imageUrl !== undefined) {
    next.imageUrl = override.imageUrl || undefined;
  }
  return next;
}

/** Apply per-row overrides and drop excluded indices. */
export function applySlotImportEdits(
  slotId: string,
  items: Item[],
  overrides: SlotImportOverlayMap,
  excluded: SlotImportExcludedRows,
): Item[] {
  const out: Item[] = [];
  items.forEach((item, index) => {
    const key = slotImportOverlayKey(slotId, index);
    if (excluded.has(key)) return;
    out.push(applySlotImportItemOverride(item, overrides.get(key)));
  });
  return out;
}

/** Ranking items after preview edits, optionally skipping active-sort ids. */
export function effectiveSlotImportItems(
  slotId: string,
  items: Item[],
  overrides: SlotImportOverlayMap,
  excluded: SlotImportExcludedRows,
  existingIds?: Set<string>,
): Item[] {
  const edited = applySlotImportEdits(slotId, items, overrides, excluded);
  return filterItemsNotInSort(edited, existingIds);
}

export function classifySlotImport(
  meta: SlotMeta,
  blob: AutosaveBlob | null,
  options?: SlotImportOptions,
): SlotImportEntry {
  if (options?.excludeSlotId && meta.id === options.excludeSlotId) {
    return { meta, status: 'excluded', itemCount: 0, items: null };
  }
  if (!blob) {
    return { meta, status: 'unreadable', itemCount: 0, items: null };
  }
  if (!meta.done) {
    return { meta, status: 'in_progress', itemCount: 0, items: null };
  }
  const items = extractCompletedRankingItems(blob);
  if (items.length === 0) {
    return { meta, status: 'empty', itemCount: 0, items: null };
  }
  return { meta, status: 'importable', itemCount: items.length, items };
}

/**
 * Manifest slots newest-first with per-slot import eligibility. Reads
 * blobs from localStorage — Drive-only slots are out of scope.
 */
export function listSlotImportEntries(
  manifest: SlotsManifest,
  options?: SlotImportOptions,
): SlotImportEntry[] {
  const sorted = [...manifest.slots].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return sorted.map((meta) =>
    classifySlotImport(meta, readSlotBlob(meta.id), options),
  );
}

/** Convenience wrapper when callers do not already hold the manifest. */
export function listSlotImportEntriesFromStorage(
  options?: SlotImportOptions,
): SlotImportEntry[] {
  if (!isAutosaveAvailable()) return [];
  return listSlotImportEntries(readManifest(), options);
}

export function slotImportStatusLabel(
  entry: SlotImportEntry,
  comparisons?: number,
): string {
  switch (entry.status) {
    case 'importable':
      return `${entry.itemCount} item${entry.itemCount === 1 ? '' : 's'} · done`;
    case 'in_progress': {
      const n = comparisons ?? entry.meta.comparisons;
      const items = `${entry.meta.totalItems} item${entry.meta.totalItems === 1 ? '' : 's'}`;
      return `${items} · in progress (${n} comparison${n === 1 ? '' : 's'} in)`;
    }
    case 'empty':
      return 'completed · no visible items';
    case 'unreadable':
      return 'save unreadable';
    case 'excluded':
      return 'current sort — excluded';
  }
}
