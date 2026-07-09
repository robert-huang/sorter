import { describe, expect, it } from 'vitest';
import {
  applyCompletedSortEdit,
  applySlotImportBatches,
  cloneSortState,
  derivedSlotName,
  resetBranchedSlotComparisonProgress,
} from '../completedSortEditH';
import { getPair, initSort as mergeInitSort, pickLeft, pickRight } from '../queueMergeSort';
import { seedAsSorted } from '../insertionSort';
import type { Item, MergeState } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };

function completeMerge(items: Item[]): MergeState {
  const rank = new Map(items.map((it, i) => [it.id, i]));
  let s = mergeInitSort(items, { shuffleAtStart: false });
  let safety = 1000;
  while (!s.done && safety-- > 0) {
    const pair = getPair(s);
    if (!pair) break;
    const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = leftRank <= rightRank ? pickLeft(s) : pickRight(s);
  }
  return s;
}

describe('derivedSlotName', () => {
  it('appends (new) for branch', () => {
    expect(derivedSlotName('Favourites — 2026-05-30', 'branch')).toBe(
      'Favourites — 2026-05-30 (new)',
    );
  });

  it('appends (redo) for start over', () => {
    expect(derivedSlotName('Favourites — 2026-05-30', 'redo')).toBe(
      'Favourites — 2026-05-30 (redo)',
    );
  });

  it('replaces a prior derived suffix instead of stacking', () => {
    expect(derivedSlotName('Favourites (continued)', 'branch')).toBe(
      'Favourites (new)',
    );
    expect(derivedSlotName('Favourites (new)', 'redo')).toBe('Favourites (redo)');
  });

  it('truncates long stems to fit the 120-char cap', () => {
    const stem = 'x'.repeat(120);
    const out = derivedSlotName(stem, 'branch');
    expect(out.length).toBe(120);
    expect(out.endsWith(' (new)')).toBe(true);
  });
});

describe('resetBranchedSlotComparisonProgress', () => {
  it('resets comparison counter after appendPreRanked on a branched merge slot', () => {
    const done = completeMerge([A, B, C]);
    expect(done.done).toBe(true);
    expect(done.comparisons).toBeGreaterThan(0);

    const cloned = cloneSortState(done);
    const { state: edited, resumed } = applyCompletedSortEdit(
      cloned,
      { kind: 'appendPreRanked', items: [X, Y] },
      { shuffleAtStart: false },
    );
    expect(resumed).toBe(true);
    expect(edited.comparisons).toBe(done.comparisons);

    const branched = resetBranchedSlotComparisonProgress(edited, {
      shuffleAtStart: false,
    });
    expect(branched.comparisons).toBe(0);
    expect(branched.totalComparisonsEverNeeded).toBeGreaterThan(0);
  });
});

describe('applyCompletedSortEdit', () => {
  it('keeps comparison counter when editing the same merge slot in place', () => {
    const done = completeMerge([A, B, C]);
    const priorComparisons = done.comparisons;
    const { state: edited, resumed } = applyCompletedSortEdit(
      done,
      { kind: 'appendPreRanked', items: [X, Y] },
      { shuffleAtStart: false },
    );
    expect(resumed).toBe(true);
    expect(edited.comparisons).toBe(priorComparisons);
  });

  it('reports duplicate id on addOne for a completed insertion sort', () => {
    const base = seedAsSorted([A, B]);
    expect(base.done).toBe(true);
    const { state, skipped, resumed } = applyCompletedSortEdit(
      base,
      { kind: 'addOne', item: A },
      {},
    );
    expect(state).toBe(base);
    expect(skipped).toEqual(['a']);
    expect(resumed).toBe(false);
  });
});

describe('applySlotImportBatches', () => {
  it('appends multiple pre-ranked sublists in one pass', () => {
    const done = completeMerge([A, B]);
    const batchA = [C];
    const batchB = [X, Y];
    const { state, skipped } = applySlotImportBatches(
      done,
      [
        { items: batchA, asPreRanked: true },
        { items: batchB, asPreRanked: true },
      ],
      { shuffleAtStart: false },
    );
    expect(skipped).toEqual([]);
    expect(state.done).toBe(false);
    expect(state.engine).toBe('merge');
    expect(state.items).toMatchObject({
      a: A,
      b: B,
      c: C,
      x: X,
      y: Y,
    });
  });
});
