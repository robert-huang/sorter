import { describe, expect, it } from 'vitest';
import {
  ANILIST_UNORDERED_FAVOURITE_ORDER,
  displayRankFromSortOrder,
  normalizeFavouriteEdgesForStorage,
  rankOffsetForMinSortOrder,
  sortOrderFromReorderIndex,
} from '../favouriteOrderStorage';
import type { AnilistFavouriteEdge } from '../types';

function edge(id: number, favouriteOrder: number): AnilistFavouriteEdge<{ id: number }> {
  return { favouriteOrder, node: { id } };
}

describe('favouriteOrderStorage', () => {
  it('normalizes 1-based AniList orders to 0-based contiguous sort_order', () => {
    const out = normalizeFavouriteEdgesForStorage([
      edge(2, 2),
      edge(1, 1),
      edge(3, 3),
    ]);
    expect(out.map((e) => ({ id: e.node.id, order: e.favouriteOrder }))).toEqual([
      { id: 1, order: 0 },
      { id: 2, order: 1 },
      { id: 3, order: 2 },
    ]);
  });

  it('places unordered (2000) favourites after ranked ones', () => {
    const out = normalizeFavouriteEdgesForStorage([
      edge(10, ANILIST_UNORDERED_FAVOURITE_ORDER),
      edge(1, 1),
      edge(11, ANILIST_UNORDERED_FAVOURITE_ORDER),
      edge(2, 2),
    ]);
    expect(out.map((e) => e.node.id)).toEqual([1, 2, 10, 11]);
    expect(out.map((e) => e.favouriteOrder)).toEqual([0, 1, 2, 3]);
  });

  it('rankOffsetForMinSortOrder distinguishes legacy 1-based vs normalized 0-based', () => {
    expect(rankOffsetForMinSortOrder(0)).toBe(1);
    expect(rankOffsetForMinSortOrder(1)).toBe(0);
    expect(rankOffsetForMinSortOrder(null)).toBe(1);
  });

  it('displayRankFromSortOrder applies offset once', () => {
    expect(displayRankFromSortOrder(0, 1)).toBe(1);
    expect(displayRankFromSortOrder(9, 1)).toBe(10);
    expect(displayRankFromSortOrder(1, 0)).toBe(1);
  });

  it('sortOrderFromReorderIndex is 0-based', () => {
    expect(sortOrderFromReorderIndex(0)).toBe(0);
    expect(sortOrderFromReorderIndex(4)).toBe(4);
  });
});
