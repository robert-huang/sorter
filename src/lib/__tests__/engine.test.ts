import { describe, expect, it } from 'vitest';
import {
  addItems,
  comparisonsRemaining,
  getPair,
  getRanking,
  hideItem,
  restoreProgress,
  snapshotProgress,
  transitionMergeDoneToInsertion,
  unhideItem,
} from '../engine';
import { initSort, pickLeft, pickRight } from '../queueMergeSort';
import { seedAsSorted } from '../insertionSort';
import type { InsertionState, Item, MergeState } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };

describe('engine dispatch', () => {
  it('routes getPair / comparisonsRemaining by engine', () => {
    const merge = initSort([A, B, C]);
    expect(getPair(merge)?.leftId).toBe('a');
    expect(comparisonsRemaining(merge)).toBeGreaterThan(0);

    const ins = seedAsSorted([A, B, C]);
    expect(getPair(ins)).toBeNull();
    expect(comparisonsRemaining(ins)).toBe(0);
  });

  it('snapshotProgress carries the engine discriminator', () => {
    const merge = initSort([A, B]);
    const sm = snapshotProgress(merge);
    expect(sm.engine).toBe('merge');

    const ins = seedAsSorted([A, B]);
    const si = snapshotProgress(ins);
    expect(si.engine).toBe('insertion');
  });

  it('getRanking works for both engines when done', () => {
    const ins = seedAsSorted([A, B, C]);
    expect(getRanking(ins)).toEqual(['a', 'b', 'c']);

    // Drive merge to done via the alphabetic oracle.
    let m = initSort([A, B, C]) as MergeState;
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      m = (p.leftId <= p.rightId ? pickLeft(m) : pickRight(m)) as MergeState;
    }
    expect(getRanking(m)).toEqual(['a', 'b', 'c']);
  });

  it('hide/unhide dispatch correctly per engine', () => {
    const ins = seedAsSorted([A, B, C]) as InsertionState;
    const insHidden = hideItem(ins, 'b');
    expect(insHidden.hidden).toContain('b');
    const insRestored = unhideItem(insHidden, 'b');
    expect(insRestored.hidden).toEqual([]);
  });
});

describe('addItems dispatch', () => {
  it('on a merge state: appends each item as its own singleton sublist', () => {
    const m = initSort([A]);
    const { state, skipped } = addItems(m, [B, C]);
    expect(skipped).toEqual([]);
    expect(state.engine).toBe('merge');
    if (state.engine === 'merge') {
      // B and C should each be their own singleton somewhere in the queue
      // (or in the in-flight current frame).
      const everywhere = [
        ...state.queue,
        state.current ? state.current.left : [],
        state.current ? state.current.right : [],
      ];
      const flat = everywhere.flat();
      expect(flat).toContain('b');
      expect(flat).toContain('c');
    }
  });

  it('on an insertion state: appends each item to pending in input order', () => {
    const ins = seedAsSorted([A, B]);
    const { state, skipped } = addItems(ins, [X, Y]);
    expect(skipped).toEqual([]);
    expect(state.engine).toBe('insertion');
    if (state.engine === 'insertion') {
      // Drained: x on current, y still in pending.
      expect(state.current?.insertingId).toBe('x');
      expect(state.pending).toEqual(['y']);
    }
  });

  it('reports skipped ids on either engine', () => {
    const m = initSort([A, B]);
    const dispatched = addItems(m, [A, C]);
    expect(dispatched.skipped).toEqual(['a']);

    const ins = seedAsSorted([A, B]);
    const insDispatched = addItems(ins, [B, X]);
    expect(insDispatched.skipped).toEqual(['b']);
  });
});

describe('transitionMergeDoneToInsertion', () => {
  it('seeds the merge ranking as sorted[], appends pending newItems', () => {
    // Drive a 3-item merge to done.
    let m: MergeState = initSort([A, B, C]);
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      const next = p.leftId <= p.rightId ? pickLeft(m) : pickRight(m);
      m = next as MergeState;
    }
    expect(m.done).toBe(true);
    expect(getRanking(m)).toEqual(['a', 'b', 'c']);

    const { state, skipped } = transitionMergeDoneToInsertion(m, [X, Y]);
    expect(skipped).toEqual([]);
    expect(state.engine).toBe('insertion');
    expect(state.sorted).toEqual(['a', 'b', 'c']);
    expect(state.current?.insertingId).toBe('x'); // first probe installed
    // Total budget for 2 inserts into L=3: 2+2=4
    // (i=0: ceil(log2(4))=2; i=1: ceil(log2(5))=3 actually = 3)
    // Wait: after drainPending, current handles x, sortedLen=4 once x
    // resolves; pending=[y] costs ceil(log2(5))=3. current's frame on
    // L=3 starts at ceil(log2(4))=2. Total = 2 + 3 = 5.
    expect(state.totalComparisonsEverNeeded).toBe(5);
  });

  it('throws if called on a not-done merge state', () => {
    const m = initSort([A, B, C]);
    expect(() => transitionMergeDoneToInsertion(m, [X])).toThrow();
  });

  it('dedups newItems against the merge\'s items dict', () => {
    let m: MergeState = initSort([A, B]);
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      m = (p.leftId <= p.rightId ? pickLeft(m) : pickRight(m)) as MergeState;
    }
    const { state, skipped } = transitionMergeDoneToInsertion(m, [B, X]);
    expect(skipped).toEqual(['b']);
    expect(state.current?.insertingId).toBe('x');
  });

  it('preserves hidden ids across the transition', () => {
    // Hide an item before merge completes, ensure it stays hidden in
    // the insertion state so RESULT can still show it under
    // "removed during sorting".
    let m: MergeState = initSort([A, B, C]);
    m = hideItem(m, 'b') as MergeState;
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      m = (p.leftId <= p.rightId ? pickLeft(m) : pickRight(m)) as MergeState;
    }
    expect(m.done).toBe(true);
    expect(m.hidden).toContain('b');
    const { state } = transitionMergeDoneToInsertion(m, [X]);
    expect(state.hidden).toContain('b');
  });
});

describe('cross-engine undo (restoreProgress)', () => {
  it('snapshotting a merge state then restoring onto an insertion state flips back to merge', () => {
    let m: MergeState = initSort([A, B, C]);
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      m = (p.leftId <= p.rightId ? pickLeft(m) : pickRight(m)) as MergeState;
    }
    const mergeSnap = snapshotProgress(m); // capture done-merge state
    expect(mergeSnap.engine).toBe('merge');

    const { state: ins } = transitionMergeDoneToInsertion(m, [X]);
    expect(ins.engine).toBe('insertion');

    // Now undo: restoreProgress should flip back to the merge state.
    const restored = restoreProgress(ins, mergeSnap);
    expect(restored.engine).toBe('merge');
    if (restored.engine === 'merge') {
      expect(restored.done).toBe(true);
      expect(restored.queue.length).toBe(1);
    }
  });
});
