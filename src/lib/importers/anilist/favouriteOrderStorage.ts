import type { AnilistFavouriteEdge } from './types';

/**
 * AniList's `favouriteOrder` for favourites that exist but have no explicit
 * profile rank (toggle-only, never reordered). Sorting treats these as tail.
 */
export const ANILIST_UNORDERED_FAVOURITE_ORDER = 2000;

/**
 * Cached `sort_order` in `*_favourite` tables is always 0-indexed:
 * 0 = user's #1 favourite. UI / rank filters use 1-indexed display ranks.
 */
export const FAVOURITE_SORT_ORDER_BASE = 0;

/** Convert stored `sort_order` to 1-indexed display rank. */
export function displayRankFromSortOrder(
  sortOrder: number,
  rankOffset: number,
): number {
  return sortOrder + rankOffset;
}

/**
 * When legacy rows store AniList's 1-based `favouriteOrder` verbatim, skip the
 * +1 on read. After `normalizeFavouriteEdgesForStorage` import, min is always 0.
 */
export function rankOffsetForMinSortOrder(minSortOrder: number | null): number {
  if (minSortOrder === null) {
    return 1;
  }
  return minSortOrder >= 1 ? 0 : 1;
}

/**
 * Sort edges by AniList's `favouriteOrder` then reassign contiguous 0-based
 * values (0..n-1). AniList's field is not always 0-indexed — `UpdateFavouriteOrder`
 * and some API responses use 1-based orders — so trusting the raw integer breaks
 * rank filters. Pagination order alone is also unreliable when values are out of
 * band (e.g. {@link ANILIST_UNORDERED_FAVOURITE_ORDER}).
 *
 * Used by every path that writes `sort_order` from API `favouriteOrder` (source
 * panel import, tools reorder refresh, favourites tool ensure-import).
 */
export function normalizeFavouriteEdgesForStorage<N extends { id: number }>(
  edges: AnilistFavouriteEdge<N>[],
): AnilistFavouriteEdge<N>[] {
  if (edges.length < 2) {
    return edges.length === 1
      ? [{ ...edges[0]!, favouriteOrder: FAVOURITE_SORT_ORDER_BASE }]
      : edges;
  }
  const sorted = [...edges].sort((a, b) => a.favouriteOrder - b.favouriteOrder);
  return sorted.map((edge, index) => ({ ...edge, favouriteOrder: index }));
}

/** 0-based `sort_order` for local cache after reorder UI save. */
export function sortOrderFromReorderIndex(index: number): number {
  return index;
}
