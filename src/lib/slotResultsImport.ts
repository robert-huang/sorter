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
