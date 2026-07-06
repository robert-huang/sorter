import { describe, expect, it } from 'vitest';
import {
  applySelectRankOrder,
  batchRankIndexRange,
  dragPayloadIds,
  EMPTY_SELECT_RANK_STATE,
  handleSelectRankClick,
  hasPendingReorderChanges,
  reorderByDrag,
  revertItemsToIdOrder,
  sameIdOrder,
  selectRankLabelForItem,
  type FavouriteListItem,
} from '../panels/reorderFavouritesLogic';

function items(labels: string[]): FavouriteListItem[] {
  return labels.map((label, index) => ({
    id: index + 1,
    label,
    imageUrl: null,
    sortOrder: index,
  }));
}

const THREE_PRIOR_RANKS = {
  pinnedIds: [] as number[],
  rankedIds: [10, 11, 12],
  anchorIndex: null,
};

describe('applySelectRankOrder', () => {
  it('places ranked picks first, then remaining items in prior order', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    const ordered = applySelectRankOrder(list, {
      pinnedIds: [],
      rankedIds: [2, 3, 5],
      anchorIndex: null,
    });
    expect(ordered.map((item) => item.label)).toEqual(['B', 'C', 'E', 'A', 'D']);
  });

  it('keeps pinned prefix before explicit rank picks', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    const ordered = applySelectRankOrder(list, {
      pinnedIds: [1, 2],
      rankedIds: [5],
      anchorIndex: 4,
    });
    expect(ordered.map((item) => item.label)).toEqual(['A', 'B', 'E', 'C', 'D']);
  });
});

describe('batchRankIndexRange', () => {
  it('assigns rising ranks forwards in list order', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    const state = batchRankIndexRange(list, 0, 2, EMPTY_SELECT_RANK_STATE);
    expect(state.rankedIds).toEqual([1, 2, 3]);
    expect(selectRankLabelForItem(1, state)).toBe('1');
    expect(selectRankLabelForItem(3, state)).toBe('3');
  });

  it('assigns ranks backwards from anchor with higher numbers to the left', () => {
    const list = items(['A', 'B', 'C']);
    const state = batchRankIndexRange(list, 2, 0, THREE_PRIOR_RANKS);
    expect(selectRankLabelForItem(1, state)).toBe('6');
    expect(selectRankLabelForItem(2, state)).toBe('5');
    expect(selectRankLabelForItem(3, state)).toBe('4');
    expect(state.rankedIds.slice(-3)).toEqual([3, 2, 1]);
  });

  it('no-ops when a non-anchor chip in the range already has a rank', () => {
    const list = items(['A', 'B', 'C', 'D']);
    const prior = {
      pinnedIds: [],
      rankedIds: [2],
      anchorIndex: 3,
    };
    const state = batchRankIndexRange(list, 3, 0, prior);
    expect(state).toBe(prior);
  });

  it('allows shift batch when only the anchor chip in the range is already ranked', () => {
    const list = items(['A', 'B', 'C']);
    const clickedAnchor = handleSelectRankClick(list, 2, false, THREE_PRIOR_RANKS);
    const state = batchRankIndexRange(list, 2, 0, clickedAnchor);
    expect(selectRankLabelForItem(3, state)).toBe('4');
    expect(selectRankLabelForItem(2, state)).toBe('5');
    expect(selectRankLabelForItem(1, state)).toBe('6');
  });
});

describe('handleSelectRankClick', () => {
  it('shift-click forwards batches ranks from the last-clicked anchor', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    let state = handleSelectRankClick(list, 0, false, EMPTY_SELECT_RANK_STATE);
    state = handleSelectRankClick(list, 2, true, state);
    expect(state.rankedIds).toEqual([1, 2, 3]);
    expect(state.anchorIndex).toBe(2);
  });

  it('clicking a ranked chip again clears that rank for the next pick', () => {
    const list = items(['A', 'B', 'C', 'D']);
    let state = handleSelectRankClick(list, 0, false, EMPTY_SELECT_RANK_STATE);
    state = handleSelectRankClick(list, 1, false, state);
    state = handleSelectRankClick(list, 2, false, state);
    expect(selectRankLabelForItem(3, state)).toBe('3');
    state = handleSelectRankClick(list, 2, false, state);
    expect(selectRankLabelForItem(3, state)).toBeNull();
    state = handleSelectRankClick(list, 3, false, state);
    expect(selectRankLabelForItem(4, state)).toBe('3');
  });

  it('shift-click backwards from last-clicked anchor gives C4 B5 A6 when next rank is 4', () => {
    const list = items(['A', 'B', 'C']);
    let state = handleSelectRankClick(list, 2, false, THREE_PRIOR_RANKS);
    state = handleSelectRankClick(list, 0, true, state);
    expect(selectRankLabelForItem(1, state)).toBe('6');
    expect(selectRankLabelForItem(2, state)).toBe('5');
    expect(selectRankLabelForItem(3, state)).toBe('4');
    expect(state.anchorIndex).toBe(0);
  });

  it('shift-click no-ops when a non-anchor chip in the range already has a rank', () => {
    const list = items(['A', 'B', 'C', 'D']);
    const prior = {
      pinnedIds: [],
      rankedIds: [2],
      anchorIndex: 3,
    };
    const state = handleSelectRankClick(list, 0, true, prior);
    expect(state).toBe(prior);
  });
});

describe('reorderByDrag', () => {
  it('moves a single item before the target index', () => {
    const list = items(['A', 'B', 'C', 'D']);
    const next = reorderByDrag(list, [3], 1);
    expect(next.map((item) => item.label)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('moves a multi-select block as a group', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    const next = reorderByDrag(list, [2, 5], 0);
    expect(next.map((item) => item.label)).toEqual(['B', 'E', 'A', 'C', 'D']);
  });
});

describe('dragPayloadIds', () => {
  it('drags the whole selection when the dragged row is selected', () => {
    const list = items(['A', 'B', 'C']);
    const selected = new Set([1, 3]);
    expect(dragPayloadIds(list, 1, selected)).toEqual([1, 3]);
  });

  it('drags only the dragged row when it is not part of a selection', () => {
    const list = items(['A', 'B', 'C']);
    const selected = new Set([1]);
    expect(dragPayloadIds(list, 2, selected)).toEqual([2]);
  });
});

describe('sameIdOrder', () => {
  it('compares id sequences', () => {
    expect(sameIdOrder([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameIdOrder([1, 2], [1, 2, 3])).toBe(false);
    expect(sameIdOrder([1, 3, 2], [1, 2, 3])).toBe(false);
  });
});

describe('revertItemsToIdOrder', () => {
  it('restores saved id order', () => {
    const reordered = revertItemsToIdOrder(
      [
        { id: 2, label: 'B', imageUrl: null, sortOrder: 0 },
        { id: 3, label: 'C', imageUrl: null, sortOrder: 1 },
        { id: 1, label: 'A', imageUrl: null, sortOrder: 2 },
      ],
      [1, 2, 3],
    );
    expect(reordered.map((item) => item.label)).toEqual(['A', 'B', 'C']);
  });
});

describe('hasPendingReorderChanges', () => {
  it('detects selection and rank state', () => {
    const list = items(['A', 'B']);
    expect(
      hasPendingReorderChanges(list, [1, 2], EMPTY_SELECT_RANK_STATE, new Set(), 'drag'),
    ).toBe(false);
    expect(
      hasPendingReorderChanges(list, [1, 2], EMPTY_SELECT_RANK_STATE, new Set([2]), 'drag'),
    ).toBe(true);
    expect(
      hasPendingReorderChanges(
        list,
        [1, 2],
        { pinnedIds: [], rankedIds: [2], anchorIndex: 1 },
        new Set(),
        'select-rank',
      ),
    ).toBe(true);
    expect(
      hasPendingReorderChanges(
        list,
        [1, 2],
        { pinnedIds: [], rankedIds: [2], anchorIndex: 1 },
        new Set(),
        'drag',
      ),
    ).toBe(false);
  });
});
