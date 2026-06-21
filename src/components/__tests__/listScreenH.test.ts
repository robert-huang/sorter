import { describe, expect, it } from 'vitest';
import {
  getInsertMergeContext,
  groupInsertionPending,
  insertionSortFromSublists,
  mergeSliceLabel,
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

describe('getInsertMergeContext', () => {
  it('returns target and remaining ids during auto-insert', () => {
    const ctx = getInsertMergeContext(
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
      targetIds: ['t1', 't2', 't3'],
      remainingIds: ['p1', 'p2', 'p3'],
      insertingId: 'p1',
      probeId: 't2',
    });
  });

  it('returns manual-insert target from the queue sublist', () => {
    const ctx = getInsertMergeContext(
      mergeState({
        queue: [['q1', 'q2', 'q3']],
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
      targetIds: ['q1', 'q2', 'q3'],
      remainingIds: ['x'],
      insertingId: 'x',
      probeId: 'q1',
    });
  });

  it('returns null outside an active insert frame', () => {
    expect(getInsertMergeContext(mergeState({}))).toBeNull();
    expect(
      getInsertMergeContext(
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
