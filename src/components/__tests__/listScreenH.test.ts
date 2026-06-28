import { describe, expect, it } from 'vitest';
import {
  formatOrphanHiddenId,
  getInsertContext,
  groupInsertionPending,
  hiddenIdsNotInRanking,
  insertionSortFromSublists,
  listHeaderItemCount,
  mergeSliceLabel,
  rankLabelForHiddenId,
  rankingSlotIds,
} from '../listScreenH';
import type { MergeState } from '../../lib/types';

function mergeState(partial: Partial<MergeState>): MergeState {
  return {
    engine: 'merge',
    items: {},
    queue: [],
    current: null,
    comparisons: 0,
    done: false,
    hidden: [],
    totalComparisonsEverNeeded: 0,
    toBeInserted: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
    ...partial,
  };
}

describe('getInsertContext', () => {
  it('returns target and remaining ids during auto-insert', () => {
    const ctx = getInsertContext(
      mergeState({
        currentAutoInsert: {
          target: ['t1', 't2', 't3'],
          pendingInserts: ['p2', 'p3'],
          frame: {
            insertingId: 'p1',
            lo: 0,
            hi: 2,
            probe: 1,
          },
          lastInsertedPosition: null,
        },
      }),
    );
    expect(ctx).toEqual({
      kind: 'merge-auto',
      targetIds: ['t1', 't2', 't3'],
      remainingIds: ['p1', 'p2', 'p3'],
      insertingId: 'p1',
      probeId: 't2',
    });
  });

  it('returns manual-insert target from the queue sublist', () => {
    const ctx = getInsertContext(
      mergeState({
        queue: [['q1', 'q2', 'q3']],
        pendingManualInserts: ['y', 'z'],
        currentManualInsert: {
          insertingId: 'x',
          targetQueueIndex: 0,
          frame: {
            insertingId: 'x',
            lo: 0,
            hi: 2,
            probe: 0,
          },
        },
      }),
    );
    expect(ctx).toEqual({
      kind: 'merge-manual',
      targetIds: ['q1', 'q2', 'q3'],
      remainingIds: ['x', 'y', 'z'],
      insertingId: 'x',
      probeId: 'q1',
    });
  });

  it('returns insertion-engine sorted list and pending queue', () => {
    const ctx = getInsertContext({
      engine: 'insertion',
      items: {},
      sorted: ['s1', 's2'],
      pending: ['p2'],
      current: {
        insertingId: 'p1',
        lo: 0,
        hi: 1,
        probe: 0,
      },
      comparisons: 0,
      done: false,
      hidden: [],
      totalComparisonsEverNeeded: 0,
    });
    expect(ctx).toEqual({
      kind: 'insertion',
      targetIds: ['s1', 's2'],
      remainingIds: ['p1', 'p2'],
      insertingId: 'p1',
      probeId: 's1',
    });
  });

  it('returns null outside an active insert frame', () => {
    expect(getInsertContext(mergeState({}))).toBeNull();
    expect(
      getInsertContext(
        mergeState({
          current: { left: ['a'], right: ['b'], merged: [] },
        }),
      ),
    ).toBeNull();
  });
});

describe('mergeSliceLabel', () => {
  it('appends the count in parentheses', () => {
    expect(mergeSliceLabel('Merged so far', 1)).toBe('Merged so far (1)');
    expect(mergeSliceLabel('Left remaining', 4)).toBe('Left remaining (4)');
  });
});

describe('groupInsertionPending', () => {
  it('returns one flat group when run metadata is absent', () => {
    expect(groupInsertionPending(['A', 'B', 'C'], undefined)).toEqual([
      { kind: 'flat', ids: ['A', 'B', 'C'] },
    ]);
  });

  it('splits pre-ranked runs from trailing singleton extras', () => {
    // Run 0: two-item sublist; runs 1–2: shuffled extras.
    expect(
      groupInsertionPending(
        ['a1', 'a2', 'x', 'y'],
        [0, 0, 1, 2],
      ),
    ).toEqual([
      { kind: 'preranked', runId: 0, ids: ['a1', 'a2'] },
      { kind: 'extras', ids: ['x', 'y'] },
    ]);
  });

  it('keeps multiple pre-ranked runs in FIFO order', () => {
    expect(
      groupInsertionPending(
        ['b1', 'b2', 'c1', 'c2', 'c3'],
        [0, 0, 1, 1, 1],
      ),
    ).toEqual([
      { kind: 'preranked', runId: 0, ids: ['b1', 'b2'] },
      { kind: 'preranked', runId: 1, ids: ['c1', 'c2', 'c3'] },
    ]);
  });

  it('returns empty for an empty pending list', () => {
    expect(groupInsertionPending([], [0, 0])).toEqual([]);
  });
});

describe('insertionSortFromSublists', () => {
  it('is true only when pendingRunIds is defined', () => {
    expect(insertionSortFromSublists(undefined)).toBe(false);
    expect(insertionSortFromSublists([0, 0])).toBe(true);
  });
});

describe('formatOrphanHiddenId', () => {
  it('replaces hyphens with spaces', () => {
    expect(formatOrphanHiddenId('ponkotsu-fuukiiin--manga')).toBe(
      'ponkotsu fuukiiin  manga',
    );
  });
});

describe('rankingSlotIds / hiddenIdsNotInRanking', () => {
  it('treats insertion sorted and pending as ranking slots', () => {
    const state = {
      engine: 'insertion' as const,
      items: {},
      sorted: ['a', 'b'],
      pending: ['c'],
      current: null,
      comparisons: 0,
      done: true,
      hidden: ['ghost', 'b'],
      totalComparisonsEverNeeded: 0,
    };
    expect([...rankingSlotIds(state)]).toEqual(['a', 'b', 'c']);
    expect(hiddenIdsNotInRanking(state)).toEqual(['ghost']);
  });

  it('lists merge queue and toBeInserted as ranking slots', () => {
    const state = mergeState({
      queue: [['q1']],
      toBeInserted: ['t1'],
      hidden: ['orphan', 'q1'],
    });
    expect([...rankingSlotIds(state)]).toEqual(['q1', 't1']);
    expect(hiddenIdsNotInRanking(state)).toEqual(['orphan']);
  });
});

describe('listHeaderItemCount', () => {
  it('counts ranking slots, not stale catalog-only items', () => {
    const state = {
      engine: 'insertion' as const,
      items: {
        a: { id: 'a', label: 'A' },
        b: { id: 'b', label: 'B' },
        ghost: { id: 'ghost', label: 'Ghost' },
      },
      sorted: ['a', 'b'],
      pending: [],
      current: null,
      comparisons: 0,
      done: true,
      hidden: [],
      totalComparisonsEverNeeded: 0,
    };
    expect(listHeaderItemCount(state)).toBe(2);
  });

  it('includes the in-flight inserting id during insertion', () => {
    const state = {
      engine: 'insertion' as const,
      items: { a: { id: 'a', label: 'A' }, x: { id: 'x', label: 'X' } },
      sorted: ['a'],
      pending: [],
      current: { insertingId: 'x', lo: 0, hi: 0, probe: 0 },
      comparisons: 0,
      done: false,
      hidden: [],
      totalComparisonsEverNeeded: 0,
    };
    expect(listHeaderItemCount(state)).toBe(2);
  });
});

describe('rankLabelForHiddenId', () => {
  it('shows 1-based rank in a completed merge sublist', () => {
    const state = mergeState({
      done: true,
      queue: [['a', 'b', 'c']],
      hidden: ['b'],
    });
    expect(rankLabelForHiddenId(state, 'b')).toBe('2.');
  });
});
