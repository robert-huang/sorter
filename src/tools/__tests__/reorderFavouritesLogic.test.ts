import { describe, expect, it, beforeEach } from 'vitest';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../../lib/importers/anilist/displayPreferences';
import {
  applySelectRankOrder,
  batchRankIndexRange,
  dragInsertIndexAtChip,
  dragInsertIndexForChipPointer,
  dragInsertIndexFromPointer,
  chipInsertSideFromPointer,
  dragPayloadIds,
  EMPTY_SELECT_RANK_STATE,
  handleSelectRankClick,
  hasPendingReorderChanges,
  reorderByDrag,
  reorderByDragDisplayPreview,
  relabelFavouriteListItem,
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

describe('reorderByDragDisplayPreview', () => {
  it('collapses a multi-select drag to one grid slot', () => {
    const list = items(['A', 'B', 'C', 'D', 'E']);
    const preview = reorderByDragDisplayPreview(list, [2, 5], 0);
    expect(preview.map((item) => item.label)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('keeps single-item drag preview unchanged', () => {
    const list = items(['A', 'B', 'C', 'D']);
    const preview = reorderByDragDisplayPreview(list, [3], 1);
    expect(preview.map((item) => item.label)).toEqual(['A', 'C', 'B', 'D']);
  });
});

describe('relabelFavouriteListItem', () => {
  beforeEach(() => {
    _clearAnilistDisplayPreferencesForTesting();
  });

  it('relabels staff from stored name fields when person name mode changes', () => {
    saveAnilistDisplayPreferences({ personNameMode: 'full' });
    const item = relabelFavouriteListItem({
      id: 1,
      label: 'Yui Horie',
      imageUrl: null,
      sortOrder: 0,
      anilistLabelSource: {
        kind: 'person',
        nameFields: { id: 1, name_full: 'Yui Horie', name_native: '堀江由衣' },
        fallbackLabel: 'Staff',
      },
    });
    expect(item.label).toBe('Yui Horie');

    saveAnilistDisplayPreferences({ personNameMode: 'native' });
    expect(relabelFavouriteListItem(item).label).toBe('堀江由衣');
  });

  it('returns the same reference when label is unchanged', () => {
    const item = {
      id: 1,
      label: 'Studio Ghibli',
      imageUrl: null,
      sortOrder: 0,
    };
    expect(relabelFavouriteListItem(item)).toBe(item);
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

describe('dragInsertIndexAtChip', () => {
  it('inserts before the chip by default', () => {
    expect(dragInsertIndexAtChip(2, false, 5)).toBe(2);
  });

  it('inserts after the chip when requested', () => {
    expect(dragInsertIndexAtChip(2, true, 5)).toBe(3);
  });

  it('clamps to list length', () => {
    expect(dragInsertIndexAtChip(4, true, 5)).toBe(5);
  });
});

describe('chipInsertSideFromPointer', () => {
  it('uses the left band for insert-before', () => {
    expect(chipInsertSideFromPointer(20, 0, 100)).toBe('before');
  });

  it('uses the right band for insert-after', () => {
    expect(chipInsertSideFromPointer(80, 0, 100)).toBe('after');
  });

  it('holds in the center band to avoid boundary flicker', () => {
    expect(chipInsertSideFromPointer(50, 0, 100)).toBe('hold');
  });
});

describe('dragInsertIndexForChipPointer', () => {
  it('uses vertical position in the horizontal center band', () => {
    expect(dragInsertIndexForChipPointer(2, 50, 20, 0, 0, 100, 100, 5)).toBe(2);
    expect(dragInsertIndexForChipPointer(2, 50, 80, 0, 0, 100, 100, 5)).toBe(3);
  });
});

describe('dragInsertIndexFromPointer', () => {
  const list = items(['A', 'B', 'C', 'D']);

  it('inserts before a chip when pointer is on its left band', () => {
    const rects = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 110, right: 210, top: 0, bottom: 100 },
      { id: 3, left: 220, right: 320, top: 0, bottom: 100 },
    ];
    expect(dragInsertIndexFromPointer(list, rects, 240, 50)).toBe(2);
  });

  it('inserts after the rightmost chip on a row when pointer is past it', () => {
    const rects = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 110, right: 210, top: 0, bottom: 100 },
      { id: 3, left: 0, right: 100, top: 110, bottom: 210 },
    ];
    expect(dragInsertIndexFromPointer(list, rects, 200, 50)).toBe(2);
  });

  it('inserts at end when pointer is below the grid', () => {
    const rects = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 110, right: 210, top: 0, bottom: 100 },
    ];
    expect(dragInsertIndexFromPointer(list, rects, 50, 250)).toBe(4);
  });

  it('snaps between rows to the nearest column chip', () => {
    const rects = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 110, right: 210, top: 0, bottom: 100 },
      { id: 3, left: 0, right: 100, top: 110, bottom: 210 },
    ];
    expect(dragInsertIndexFromPointer(list, rects, 50, 105)).toBe(2);
  });
});
