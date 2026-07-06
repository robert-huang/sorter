import type { AnilistFavouriteType } from '../../lib/importers/anilist/types';

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
};

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
