import { describe, expect, it } from 'vitest';
import {
  groupInsertionPending,
  insertionSortFromSublists,
  mergeSliceLabel,
} from '../listScreenH';

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
