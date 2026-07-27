import { describe, expect, it } from 'vitest';
import { formatDocumentTitle } from '../documentTitleH';
import { pickVisualSide, getPair } from '../engine';
import {
  addItem,
  restoreProgress,
  pickLeft,
  pickRight,
} from '../queueMergeSort';
import type { Item } from '../types';
import { loadCompletedReaddFixture } from './completedReaddFixture';

describe('re-add to completed merge sort', () => {
  it('flips done back to true after singleton auto-insert completes', () => {
    const { items, undoRing } = loadCompletedReaddFixture();
    const beforeAdd = undoRing[0];
    expect(beforeAdd.done).toBe(true);
    expect(beforeAdd.queue.length).toBe(1);

    let state = restoreProgress({ ...beforeAdd, items }, beforeAdd);

    const newItem: Item = {
      id: 'test-new-item',
      label: 'Test New Item',
    };
    const added = addItem(state, newItem, { autoInsertEnabled: true });
    expect(added).not.toBeNull();
    state = added!;
    expect(state.done).toBe(false);

    let guard = 0;
    while (!state.done && guard++ < 500) {
      const pair = getPair(state);
      if (!pair) break;
      state =
        pair.leftId <= pair.rightId
          ? pickLeft(state, { autoInsertEnabled: true })
          : pickRight(state, { autoInsertEnabled: true });
    }

    expect(state.done).toBe(true);
    expect(getPair(state)).toBeNull();
    expect(state.queue.length).toBe(1);
    expect(state.queue[0]).toContain('test-new-item');
  });

  it('last pick sets done and title switches from percent to checkmark', () => {
    const { items, progress, undoRing } = loadCompletedReaddFixture();
    const penult = undoRing[1];
    const penultState = restoreProgress({ ...penult, items }, penult);
    expect(getPair(penultState)).not.toBeNull();
    expect(
      formatDocumentTitle(penultState, 'Slot', { autoInsertEnabled: true }),
    ).toMatch(/\(\d+(\.\d+)?%\) — Sorter$/);

    let next = pickVisualSide(penultState, 'left', { autoInsertEnabled: true });
    if (!next.done) {
      next = pickVisualSide(penultState, 'right', { autoInsertEnabled: true });
    }

    expect(next.done).toBe(true);
    expect(next.comparisons).toBe(progress.comparisons);
    expect(formatDocumentTitle(next, 'Slot', { autoInsertEnabled: true })).toBe(
      'Slot ✓ — Sorter',
    );
  });
});
