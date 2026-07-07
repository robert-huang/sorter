import type { AnilistFavouriteType } from '../../lib/importers/anilist/types';
import { resolveAnilistItemLabel } from '../../lib/importers/anilist/anilistItemLabel';
import type { AnilistItemLabelSource } from '../../lib/types';

/** Dropdown order: characters first (default), then staff, anime, manga, studio. */
export const REORDER_FAVOURITE_TYPE_OPTIONS: ReadonlyArray<{
  value: AnilistFavouriteType;
  label: string;
}> = [
  { value: 'CHARACTERS', label: 'Characters' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'ANIME', label: 'Anime' },
  { value: 'MANGA', label: 'Manga' },
  { value: 'STUDIOS', label: 'Studio' },
];

export type ReorderFavouritesForm = {
  username: string;
  favouriteType: AnilistFavouriteType;
};

export const DEFAULT_REORDER_FAVOURITES_FORM: ReorderFavouritesForm = {
  username: '',
  favouriteType: 'CHARACTERS',
};

export type FavouriteListItem = {
  id: number;
  label: string;
  imageUrl: string | null;
  /** 0-based rank from AniList / cache. */
  sortOrder: number;
  /** Re-label when AniList display preferences change. */
  anilistLabelSource?: AnilistItemLabelSource;
};

export function relabelFavouriteListItem(item: FavouriteListItem): FavouriteListItem {
  if (!item.anilistLabelSource) {
    return item;
  }
  const label = resolveAnilistItemLabel(item.anilistLabelSource, false);
  return label === item.label ? item : { ...item, label };
}

export function relabelFavouriteListItems(
  items: readonly FavouriteListItem[],
): FavouriteListItem[] {
  return items.map(relabelFavouriteListItem);
}

export type ReorderInteractionMode = 'drag' | 'select-rank';

export type SelectRankState = {
  /** Items shift-selected as an already-sorted prefix (keep relative order). */
  pinnedIds: number[];
  /** Items explicitly ranked, in pick order, after the pinned prefix. */
  rankedIds: number[];
  /** Anchor list index for shift-range selection. */
  anchorIndex: number | null;
};

export const EMPTY_SELECT_RANK_STATE: SelectRankState = {
  pinnedIds: [],
  rankedIds: [],
  anchorIndex: null,
};

export type RecentlyDeletedBucket = {
  username: string;
  favouriteType: AnilistFavouriteType;
  items: FavouriteListItem[];
  deletedAt: number;
};

export const REORDER_FAVOURITES_RECENTLY_DELETED_KEY =
  'reorder-favourites-recently-deleted';

export function loadRecentlyDeletedBuckets(): RecentlyDeletedBucket[] {
  try {
    const raw = sessionStorage.getItem(REORDER_FAVOURITES_RECENTLY_DELETED_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentlyDeletedBucket[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecentlyDeletedBuckets(buckets: RecentlyDeletedBucket[]): void {
  try {
    sessionStorage.setItem(
      REORDER_FAVOURITES_RECENTLY_DELETED_KEY,
      JSON.stringify(buckets),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

export function appendRecentlyDeleted(bucket: RecentlyDeletedBucket): void {
  const existing = loadRecentlyDeletedBuckets();
  saveRecentlyDeletedBuckets([bucket, ...existing]);
}

/** Merge pinned prefix, explicit rank picks, then remaining items in prior order. */
export function applySelectRankOrder(
  items: readonly FavouriteListItem[],
  state: SelectRankState,
): FavouriteListItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const used = new Set<number>();
  const out: FavouriteListItem[] = [];

  for (const item of items) {
    if (state.pinnedIds.includes(item.id)) {
      out.push(item);
      used.add(item.id);
    }
  }

  for (const id of state.rankedIds) {
    if (used.has(id)) {
      continue;
    }
    const item = byId.get(id);
    if (item) {
      out.push(item);
      used.add(id);
    }
  }

  for (const item of items) {
    if (!used.has(item.id)) {
      out.push(item);
    }
  }

  return out;
}

export function listIndexRange(start: number, end: number): number[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const indices: number[] = [];
  for (let i = lo; i <= hi; i += 1) {
    indices.push(i);
  }
  return indices;
}

function itemHasRank(state: SelectRankState, itemId: number): boolean {
  return state.pinnedIds.includes(itemId) || state.rankedIds.includes(itemId);
}

/**
 * Shift+click: assign consecutive ranks to every unnumbered chip in the range.
 * Forward (anchor → click): list order gets startRank, startRank+1, …
 * Backward (anchor → click): anchor gets startRank, then each step left gets +1 (C4 B5 A6).
 * No-op when any chip in the range already has a rank number.
 */
export function batchRankIndexRange(
  items: readonly FavouriteListItem[],
  anchorIndex: number,
  endIndex: number,
  state: SelectRankState,
): SelectRankState {
  for (const index of listIndexRange(anchorIndex, endIndex)) {
    if (index === anchorIndex) {
      continue;
    }
    const item = items[index];
    if (item && itemHasRank(state, item.id)) {
      return state;
    }
  }

  const rangeIds = new Set(
    listIndexRange(anchorIndex, endIndex)
      .map((index) => items[index]?.id)
      .filter((id): id is number => id != null),
  );
  const rankedIds = state.rankedIds.filter((id) => !rangeIds.has(id));
  const pinnedIds = state.pinnedIds.filter((id) => !rangeIds.has(id));
  const batchState: SelectRankState = { ...state, rankedIds, pinnedIds };

  const startRank = pinnedIds.length + rankedIds.length + 1;
  let rank = startRank;
  const assignments: Array<{ id: number; rank: number }> = [];

  if (endIndex >= anchorIndex) {
    for (let i = anchorIndex; i <= endIndex; i += 1) {
      const item = items[i];
      if (item) {
        assignments.push({ id: item.id, rank: rank++ });
      }
    }
  } else {
    for (let i = anchorIndex; i >= endIndex; i -= 1) {
      const item = items[i];
      if (item) {
        assignments.push({ id: item.id, rank: rank++ });
      }
    }
  }

  const newIds = assignments
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.id);

  return {
    ...batchState,
    rankedIds: [...rankedIds, ...newIds],
    anchorIndex: endIndex,
  };
}

function removeIdFromRankState(state: SelectRankState, itemId: number): SelectRankState {
  return {
    pinnedIds: state.pinnedIds.filter((id) => id !== itemId),
    rankedIds: state.rankedIds.filter((id) => id !== itemId),
    anchorIndex: state.anchorIndex,
  };
}

/** Click in select-rank mode → rank next slot, or clear an existing rank on re-click. */
export function rankItemAtIndex(
  items: readonly FavouriteListItem[],
  index: number,
  state: SelectRankState,
): SelectRankState {
  const item = items[index];
  if (!item) {
    return { ...state, anchorIndex: index };
  }
  if (state.pinnedIds.includes(item.id) || state.rankedIds.includes(item.id)) {
    return { ...removeIdFromRankState(state, item.id), anchorIndex: index };
  }
  return {
    ...state,
    rankedIds: [...state.rankedIds, item.id],
    anchorIndex: index,
  };
}

export function handleSelectRankClick(
  items: readonly FavouriteListItem[],
  index: number,
  shiftKey: boolean,
  state: SelectRankState,
): SelectRankState {
  if (shiftKey) {
    const anchor = state.anchorIndex ?? index;
    return batchRankIndexRange(items, anchor, index, state);
  }
  return rankItemAtIndex(items, index, state);
}

export function selectRankLabelForItem(
  itemId: number,
  state: SelectRankState,
): string | null {
  const pinnedIndex = state.pinnedIds.indexOf(itemId);
  if (pinnedIndex >= 0) {
    return String(pinnedIndex + 1);
  }
  const rankedIndex = state.rankedIds.indexOf(itemId);
  if (rankedIndex >= 0) {
    return String(state.pinnedIds.length + rankedIndex + 1);
  }
  return null;
}

export function wouldSelectRankChangeOrder(
  items: readonly FavouriteListItem[],
  savedIds: readonly number[],
  state: SelectRankState,
): boolean {
  if (!hasSelectRankChanges(state)) {
    return false;
  }
  return !sameIdOrder(favouriteIdsInOrder(applySelectRankOrder(items, state)), savedIds);
}

/** Map chip hover + pointer side to a list insert index (before `targetIndex`). */
export function dragInsertIndexAtChip(
  chipIndex: number,
  insertAfter: boolean,
  listLength: number,
): number {
  const raw = insertAfter ? chipIndex + 1 : chipIndex;
  return Math.max(0, Math.min(raw, listLength));
}

export type ChipInsertSide = 'before' | 'after' | 'hold';

/** Decide insert side from pointer X; center band keeps the prior choice stable. */
export function chipInsertSideFromPointer(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
): ChipInsertSide {
  if (rectWidth <= 0) {
    return 'before';
  }
  const ratio = (clientX - rectLeft) / rectWidth;
  if (ratio < 0.35) {
    return 'before';
  }
  if (ratio > 0.65) {
    return 'after';
  }
  return 'hold';
}

/** Insert index for a pointer over one chip; horizontal bands, vertical split in the center. */
export function dragInsertIndexForChipPointer(
  chipIndex: number,
  clientX: number,
  clientY: number,
  rectLeft: number,
  rectTop: number,
  rectWidth: number,
  rectHeight: number,
  listLength: number,
): number {
  const ratioX = rectWidth > 0 ? (clientX - rectLeft) / rectWidth : 0;
  const ratioY = rectHeight > 0 ? (clientY - rectTop) / rectHeight : 0;
  if (ratioX < 0.35) {
    return dragInsertIndexAtChip(chipIndex, false, listLength);
  }
  if (ratioX > 0.65) {
    return dragInsertIndexAtChip(chipIndex, true, listLength);
  }
  return dragInsertIndexAtChip(chipIndex, ratioY > 0.5, listLength);
}

function chipRectContainsPointer(
  rect: DragChipRect,
  clientX: number,
  clientY: number,
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function insertIndexInColumnGap(
  mapped: ReadonlyArray<{ rect: DragChipRect; index: number }>,
  clientX: number,
  clientY: number,
  listLength: number,
): number | null {
  const columnSlackPx = 12;
  const columnChips = mapped.filter(
    ({ rect }) =>
      clientX >= rect.left - columnSlackPx && clientX <= rect.right + columnSlackPx,
  );
  if (columnChips.length === 0) {
    return null;
  }
  const below = columnChips
    .filter(({ rect }) => rect.top > clientY)
    .sort((a, b) => a.rect.top - b.rect.top)[0];
  const above = columnChips
    .filter(({ rect }) => rect.bottom < clientY)
    .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
  if (below && above) {
    const gapMid = (above.rect.bottom + below.rect.top) / 2;
    return dragInsertIndexAtChip(below.index, clientY > gapMid, listLength);
  }
  if (below) {
    return dragInsertIndexAtChip(below.index, false, listLength);
  }
  if (above) {
    return dragInsertIndexAtChip(above.index, true, listLength);
  }
  return null;
}

function nearestChipToPointer(
  mapped: ReadonlyArray<{ rect: DragChipRect; index: number }>,
  clientX: number,
  clientY: number,
): { rect: DragChipRect; index: number } | null {
  let nearest: { rect: DragChipRect; index: number; distance: number } | null = null;
  for (const entry of mapped) {
    const centerX = (entry.rect.left + entry.rect.right) / 2;
    const centerY = (entry.rect.top + entry.rect.bottom) / 2;
    const distance = Math.hypot(clientX - centerX, clientY - centerY);
    if (!nearest || distance < nearest.distance) {
      nearest = { ...entry, distance };
    }
  }
  if (!nearest) {
    return null;
  }
  return { rect: nearest.rect, index: nearest.index };
}

export type DragChipRect = {
  id: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const DRAG_ROW_Y_TOLERANCE_PX = 4;

/** Resolve insert index from pointer position over the chip grid (gaps + row ends). */
export function dragInsertIndexFromPointer(
  items: readonly { id: number }[],
  chipRects: readonly DragChipRect[],
  clientX: number,
  clientY: number,
): number {
  if (items.length === 0) {
    return 0;
  }
  if (chipRects.length === 0) {
    return items.length;
  }

  const indexById = new Map(items.map((item, index) => [item.id, index]));
  const mapped = chipRects
    .map((rect) => ({ rect, index: indexById.get(rect.id) }))
    .filter(
      (entry): entry is { rect: DragChipRect; index: number } =>
        entry.index !== undefined,
    );

  if (mapped.length === 0) {
    return items.length;
  }

  const rowChips = mapped.filter(
    ({ rect }) =>
      clientY >= rect.top - DRAG_ROW_Y_TOLERANCE_PX &&
      clientY <= rect.bottom + DRAG_ROW_Y_TOLERANCE_PX,
  );

  if (rowChips.length > 0) {
    rowChips.sort((a, b) => a.rect.left - b.rect.left);
    for (const { rect, index } of rowChips) {
      if (chipRectContainsPointer(rect, clientX, clientY)) {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        return dragInsertIndexForChipPointer(
          index,
          clientX,
          clientY,
          rect.left,
          rect.top,
          width,
          height,
          items.length,
        );
      }
    }
    for (const { rect, index } of rowChips) {
      const width = rect.right - rect.left;
      const ratio = width > 0 ? (clientX - rect.left) / width : 0;
      if (ratio < 0.65) {
        return dragInsertIndexAtChip(index, false, items.length);
      }
    }
    const rightmost = rowChips[rowChips.length - 1]!;
    return dragInsertIndexAtChip(rightmost.index, true, items.length);
  }

  const sortedByTop = [...mapped].sort((a, b) => a.rect.top - b.rect.top);
  const first = sortedByTop[0]!;
  if (clientY < first.rect.top) {
    return 0;
  }
  const last = sortedByTop[sortedByTop.length - 1]!;
  if (clientY > last.rect.bottom) {
    return items.length;
  }

  const gapIndex = insertIndexInColumnGap(mapped, clientX, clientY, items.length);
  if (gapIndex != null) {
    return gapIndex;
  }

  const nearest = nearestChipToPointer(mapped, clientX, clientY);
  if (nearest) {
    const width = nearest.rect.right - nearest.rect.left;
    const height = nearest.rect.bottom - nearest.rect.top;
    return dragInsertIndexForChipPointer(
      nearest.index,
      clientX,
      clientY,
      nearest.rect.left,
      nearest.rect.top,
      width,
      height,
      items.length,
    );
  }

  return items.length;
}

const CHIP_SELECTOR = '.tool-reorder-favourites-chip[data-item-id]';

function chipRectsExcluding(
  gridRoot: HTMLElement,
  excludedIds: ReadonlySet<number>,
): DragChipRect[] {
  return Array.from(gridRoot.querySelectorAll<HTMLElement>(CHIP_SELECTOR))
    .filter((el) => !excludedIds.has(Number(el.dataset.itemId)))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: Number(el.dataset.itemId),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
}

/** Resolve insert index from pointer using live DOM hit-testing (falls back to rect geometry). */
export function dragInsertIndexFromDomPoint(
  items: readonly { id: number }[],
  gridRoot: HTMLElement | null,
  clientX: number,
  clientY: number,
  draggedIds: ReadonlySet<number>,
): number {
  if (items.length === 0) {
    return 0;
  }

  if (gridRoot) {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const node of stack) {
      if (!(node instanceof Element)) {
        continue;
      }
      const chip = node.closest<HTMLElement>(CHIP_SELECTOR);
      if (!chip || !gridRoot.contains(chip)) {
        continue;
      }
      const id = Number(chip.dataset.itemId);
      if (Number.isNaN(id) || draggedIds.has(id)) {
        continue;
      }
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) {
        continue;
      }
      const rect = chip.getBoundingClientRect();
      return dragInsertIndexForChipPointer(
        index,
        clientX,
        clientY,
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
        items.length,
      );
    }

    return dragInsertIndexFromPointer(
      items,
      chipRectsExcluding(gridRoot, draggedIds),
      clientX,
      clientY,
    );
  }

  return dragInsertIndexFromPointer(items, [], clientX, clientY);
}

/** Drag-reorder: move `draggedIds` block before `targetIndex` in the full list. */
export function reorderByDrag<T extends { id: number }>(
  items: readonly T[],
  draggedIds: readonly number[],
  targetIndex: number,
): T[] {
  if (draggedIds.length === 0) {
    return [...items];
  }
  const dragSet = new Set(draggedIds);
  const dragged = items.filter((item) => dragSet.has(item.id));
  const remaining = items.filter((item) => !dragSet.has(item.id));

  let insertAt = targetIndex;
  for (let i = 0; i < targetIndex; i += 1) {
    if (dragSet.has(items[i]!.id)) {
      insertAt -= 1;
    }
  }
  insertAt = Math.max(0, Math.min(insertAt, remaining.length));

  return [...remaining.slice(0, insertAt), ...dragged, ...remaining.slice(insertAt)];
}

/** Live drag preview: multi-select occupies one grid slot (lead item only). */
export function reorderByDragDisplayPreview<T extends { id: number }>(
  items: readonly T[],
  draggedIds: readonly number[],
  targetIndex: number,
): T[] {
  const reordered = reorderByDrag(items, draggedIds, targetIndex);
  if (draggedIds.length <= 1) {
    return reordered;
  }
  const dragSet = new Set(draggedIds);
  const leadId = draggedIds[0]!;
  let leadKept = false;
  return reordered.filter((item) => {
    if (!dragSet.has(item.id)) {
      return true;
    }
    if (item.id === leadId && !leadKept) {
      leadKept = true;
      return true;
    }
    return false;
  });
}

export function favouriteIdsInOrder(items: readonly FavouriteListItem[]): number[] {
  return items.map((item) => item.id);
}

export function itemsWithSortOrder(items: readonly FavouriteListItem[]): FavouriteListItem[] {
  return items.map((item, index) => ({ ...item, sortOrder: index }));
}

export function sameIdOrder(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
}

export function toggleSelectedId(
  selected: ReadonlySet<number>,
  id: number,
): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function dragPayloadIds(
  items: readonly FavouriteListItem[],
  draggedId: number,
  selected: ReadonlySet<number>,
): number[] {
  if (selected.has(draggedId) && selected.size > 0) {
    return items.filter((item) => selected.has(item.id)).map((item) => item.id);
  }
  return [draggedId];
}

/** Restore a list to a saved id order (drops ids missing from `byId`). */
export function revertItemsToIdOrder(
  items: readonly FavouriteListItem[],
  savedIds: readonly number[],
): FavouriteListItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return savedIds
    .map((id) => byId.get(id))
    .filter((item): item is FavouriteListItem => item != null);
}

export function hasSelectRankChanges(state: SelectRankState): boolean {
  return state.pinnedIds.length > 0 || state.rankedIds.length > 0;
}

export function hasPendingReorderChanges(
  items: readonly FavouriteListItem[],
  savedIds: readonly number[],
  selectRankState: SelectRankState,
  selected: ReadonlySet<number>,
  mode: ReorderInteractionMode,
): boolean {
  if (selected.size > 0) {
    return true;
  }
  if (mode === 'select-rank' && hasSelectRankChanges(selectRankState)) {
    return true;
  }
  return items.length > 0 && !sameIdOrder(savedIds, favouriteIdsInOrder(items));
}
