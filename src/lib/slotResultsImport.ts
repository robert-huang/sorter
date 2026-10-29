import { getRanking } from './engine';
import type { CloudSlotMeta } from './cloud';
import {
  readManifest,
  readSlotBlob,
  type AutosaveBlob,
} from './storage';
import { formatSortVersionDate } from './sortVersionShape';
import type { Item, SlotMeta, SlotsManifest, SortState, SortVersion } from './types';

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
  /** Recorded rankings carried by the save, oldest first; only when importable. */
  versions?: SortVersion[];
}

/** One ordered ranking pulled from a save: its current ranking or one recorded version. */
export interface SlotRankingImport {
  source: string;
  slotName: string;
  items: Item[];
  /** Version date, or the save's last-modified time for its current ranking. */
  createdAt?: string;
  /** Set when this import is a recorded version rather than the save's current ranking. */
  versionId?: string;
  /** The save's own version history; only on current-ranking imports. */
  versions?: SortVersion[];
}

/**
 * Picked versions of a save, oldest first, named `<slot> · <date>`. Dates that
 * collide within the pick add the time. Live item metadata (source, ids) is kept
 * where the item still exists; label, url and image come from the snapshot.
 */
export function versionImportsForSlot(
  entry: SlotImportEntry,
  versionIds: ReadonlySet<string>,
  source: string,
  slotName: string,
): SlotRankingImport[] {
  const picked = (entry.versions ?? [])
    .filter((v) => versionIds.has(v.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const dateCounts = new Map<string, number>();
  for (const v of picked) {
    const day = formatSortVersionDate(v.createdAt);
    dateCounts.set(day, (dateCounts.get(day) ?? 0) + 1);
  }
  const live = new Map((entry.items ?? []).map((it) => [it.id, it]));
  return picked.map((v) => {
    const sharesDate = (dateCounts.get(formatSortVersionDate(v.createdAt)) ?? 0) > 1;
    const items = v.rankedIds.map((id): Item => {
      const snap = v.items[id]!;
      const item: Item = { ...live.get(id), id, label: snap.label };
      if (snap.url) item.url = snap.url;
      else delete item.url;
      if (snap.imageUrl) item.imageUrl = snap.imageUrl;
      else delete item.imageUrl;
      return item;
    });
    return {
      source,
      slotName: `${slotName} · ${formatSortVersionDate(v.createdAt, sharesDate)}`,
      items,
      createdAt: v.createdAt,
      versionId: v.id,
    };
  });
}

export interface SlotImportOptions {
  /** Omit the active slot (mid-sort self-import). */
  excludeSlotId?: string;
}

export function cloudSlotImportId(cloudId: string): string {
  return `cloud:${cloudId}`;
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
  hiddenRestoreIds?: Set<string>,
): Item[] {
  if (!existingIds || existingIds.size === 0) return items;
  return items.filter(
    (it) =>
      !existingIds.has(it.id) || (hiddenRestoreIds?.has(it.id) ?? false),
  );
}

/**
 * Pre-staging edit overlay for Sort Results import preview. Keyed by
 * `${slotId}:${index}` where `index` is the item's position in the
 * slot's completed ranking (0-based). Stable across label/id edits —
 * same handle pattern as CSV preview's `sourceName:rowNumber`.
 */
export type SlotImportItemOverride = {
  /** Full cache-backed replacement used when a canonical AniList id resolves. */
  replacement?: Item;
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
  const next: Item = { ...(override.replacement ?? item) };
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
  hiddenRestoreIds?: Set<string>,
): Item[] {
  const edited = applySlotImportEdits(slotId, items, overrides, excluded);
  return filterItemsNotInSort(edited, existingIds, hiddenRestoreIds);
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
  return withEntryVersions(
    { meta, status: 'importable', itemCount: items.length, items },
    blob,
  );
}

function withEntryVersions(entry: SlotImportEntry, blob: AutosaveBlob): SlotImportEntry {
  return entry.status === 'importable' && blob.versions?.length
    ? { ...entry, versions: blob.versions }
    : entry;
}

/** Classify a downloaded Drive body without creating or reading a local slot. */
export function classifyCloudSlotImport(
  cloudMeta: CloudSlotMeta,
  blob: AutosaveBlob,
): SlotImportEntry {
  const bodyDone = blob.progress.done === true;
  const items = bodyDone ? extractCompletedRankingItems(blob) : [];
  const status: SlotImportStatus = !bodyDone
    ? 'in_progress'
    : items.length === 0
      ? 'empty'
      : 'importable';
  return withEntryVersions({
    meta: {
      id: cloudSlotImportId(cloudMeta.cloudId),
      name: cloudMeta.displayName,
      createdAt: cloudMeta.updatedAt,
      updatedAt: cloudMeta.updatedAt,
      totalItems: bodyDone ? items.length : Object.keys(blob.items).length,
      comparisons: blob.progress.comparisons,
      done: bodyDone,
    },
    status,
    itemCount: status === 'importable' ? items.length : 0,
    items: status === 'importable' ? items : null,
  }, blob);
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
