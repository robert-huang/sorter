import { describe, expect, it } from 'vitest';
import { applyCompletedSortEdit, derivedSlotName } from '../completedSortEditH';
import { seedAsSorted } from '../insertionSort';
import type { Item } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };

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

describe('applyCompletedSortEdit', () => {
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
