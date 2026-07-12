import { describe, expect, it } from 'vitest';
import {
  addItems,
  comparisonsRemaining,
  finalizeCompletedState,
  getPair,
  getRanking,
  hideItem,
  normalizeLoadedState,
  pickLeft as enginePickLeft,
  pickRight as enginePickRight,
  restoreProgress,
  returnToPending,
  rewriteIdInProgress,
  snapshotProgress,
  unhideItem,
  updateItem,
  updateItemId,
  reinsertHiddenItem,
} from '../engine';
import {
  hideItem as mergeHideItem,
  initSort as mergeInitSort,
  manualInsert,
  pickLeft,
  pickRight,
  seedAsDoneMerge,
  seedFromSublists,
  type MergeOptions,
} from '../queueMergeSort';
import {
  buildInsertionState,
  seedAsSorted,
  addItems as insertionAddItems,
} from '../insertionSort';
import type { InsertionState, Item, MergeState, SortProgress, SortState } from '../types';

/** Test helper: deterministic item order (startup shuffle disabled). */
function initSort(items: Item[], options?: MergeOptions): MergeState {
  return mergeInitSort(items, { shuffleAtStart: false, ...options });
}

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };
const D: Item = { id: 'd', label: 'D' };
const F: Item = { id: 'f', label: 'F' };
const E: Item = { id: 'e', label: 'E' };

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

  it('returnToPending dispatches to merge when engine is merge', () => {
    let m = initSort([A, B, C]) as MergeState;
    while (!m.done) {
      const p = getPair(m);
      if (!p) break;
      m = (p.leftId <= p.rightId ? pickLeft(m) : pickRight(m)) as MergeState;
    }
    expect(m.done).toBe(true);
    const next = returnToPending(m, 'b');
    expect(next.engine).toBe('merge');
    expect(next.done).toBe(false);
    if (next.engine === 'merge') {
      expect(next.currentManualInsert?.insertingId).toBe('b');
      expect(next.queue[0]).toEqual(['a', 'c']);
    }
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

describe('finalizeCompletedState', () => {
  it('converts a done insertion state to canonical merge done', () => {
    const ins = seedAsSorted([A, B, C]);
    expect(ins.engine).toBe('insertion');
    const merged = finalizeCompletedState(ins);
    expect(merged.engine).toBe('merge');
    expect(merged.done).toBe(true);
    if (merged.engine === 'merge') {
      expect(merged.queue).toEqual([['a', 'b', 'c']]);
      expect(merged.current).toBeNull();
      expect(merged.comparisons).toBe(ins.comparisons);
      expect(merged.totalComparisonsEverNeeded).toBe(
        ins.totalComparisonsEverNeeded,
      );
    }
    expect(getRanking(merged)).toEqual(['a', 'b', 'c']);
  });

  it('preserves hidden ids in the merge queue', () => {
    const ins = seedAsSorted([A, B, C]);
    ins.hidden = ['b'];
    const merged = finalizeCompletedState(ins);
    expect(merged.hidden).toEqual(['b']);
    if (merged.engine === 'merge') {
      expect(merged.queue[0]).toEqual(['a', 'b', 'c']);
    }
    expect(getRanking(merged)).toEqual(['a', 'c']);
  });

  it('is a no-op for in-progress and merge-done states', () => {
    const inProgress = initSort([A, B, C]);
    expect(finalizeCompletedState(inProgress)).toBe(inProgress);

    let done = initSort([A, B]);
    while (!done.done) {
      const p = getPair(done);
      if (!p) break;
      done = (p.leftId <= p.rightId ? pickLeft(done) : pickRight(done)) as MergeState;
    }
    expect(finalizeCompletedState(done)).toBe(done);
  });

  it('seedAsDoneMerge matches finalize of insertion seedAsSorted', () => {
    const fromInsertion = finalizeCompletedState(seedAsSorted([A, B, C]));
    const fromSeed = seedAsDoneMerge([A, B, C]);
    expect(fromSeed.engine).toBe('merge');
    expect(fromSeed.done).toBe(true);
    if (fromSeed.engine === 'merge' && fromInsertion.engine === 'merge') {
      expect(fromSeed.queue).toEqual(fromInsertion.queue);
    }
    expect(getRanking(fromSeed)).toEqual(['a', 'b', 'c']);
  });
});

describe('normalizeLoadedState', () => {
  it('repairs stale merge buckets on load', () => {
    const stalled: MergeState = {
      engine: 'merge',
      queue: [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
      current: null,
      currentManualInsert: null,
      currentAutoInsert: null,
      comparisons: 42,
      done: false,
      hidden: [],
      totalComparisonsEverNeeded: 42,
      toBeInserted: ['g'],
      pendingManualInserts: ['g'],
      items: {
        a: A,
        b: B,
        c: C,
        d: D,
        e: { id: 'e', label: 'E' },
        f: { id: 'f', label: 'F' },
        g: { id: 'g', label: 'G' },
        h: { id: 'h', label: 'H' },
      },
    };
    expect(getPair(stalled)).toBeNull();

    const loaded = normalizeLoadedState(stalled);
    expect(loaded.engine).toBe('merge');
    if (loaded.engine !== 'merge') return;
    expect(loaded.toBeInserted).toEqual([]);
    expect(loaded.pendingManualInserts).toEqual([]);
    expect(loaded.done).toBe(true);
  });

  it('repairs a collapsed in-flight frame and resumes progress', () => {
    const stalled: MergeState = {
      engine: 'merge',
      queue: [['a', 'b', 'c']],
      current: null,
      currentManualInsert: {
        insertingId: 'x',
        targetQueueIndex: 0,
        frame: { insertingId: 'x', lo: 3, hi: 3, probe: 3 },
      },
      currentAutoInsert: null,
      comparisons: 2,
      done: false,
      hidden: [],
      totalComparisonsEverNeeded: 2,
      toBeInserted: ['x'],
      pendingManualInserts: [],
      items: { a: A, b: B, c: C, x: X },
    };
    expect(getPair(stalled)).toBeNull();

    const loaded = normalizeLoadedState(stalled);
    if (loaded.engine !== 'merge') return;
    expect(loaded.currentManualInsert).toBeNull();
    expect(loaded.queue[0]).toEqual(['a', 'b', 'c', 'x']);
    expect(loaded.toBeInserted).not.toContain('x');
  });

  it('finalizes done insertion blobs after merge reconcile', () => {
    const ins = seedAsSorted([A, B, C]);
    const loaded = normalizeLoadedState(ins);
    expect(loaded.engine).toBe('merge');
    expect(loaded.done).toBe(true);
    expect(getRanking(loaded)).toEqual(['a', 'b', 'c']);
  });

  it('reinsertHiddenItem dispatches to merge reinsert path', () => {
    const seed = seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] });
    expect(seed.currentAutoInsert).not.toBeNull();
    const hidden = mergeHideItem(seed, 'd');
    const next = reinsertHiddenItem(hidden, 'd');
    expect(next.engine).toBe('merge');
    if (next.engine !== 'merge') return;
    expect(next.hidden).not.toContain('d');
    expect(next.toBeInserted).toContain('d');
    expect(next.currentAutoInsert!.target).not.toContain('d');
  });
});

describe('completion normalization on picks', () => {
  it('finalizes insertion completion without an extra undo snapshot', () => {
    const { state: ins0 } = buildInsertionState({
      sortedItems: [A, B],
      pendingItems: [C, D],
    });
    let cur = ins0;
    let snap = snapshotProgress(cur);
    let safety = 50;
    while (!cur.done && safety-- > 0) {
      const pair = getPair(cur);
      if (!pair) break;
      snap = snapshotProgress(cur);
      const next =
        pair.leftId <= pair.rightId
          ? enginePickLeft(cur)
          : enginePickRight(cur);
      if (next.done) {
        expect(next.engine).toBe('merge');
        expect(getRanking(next)).toEqual(['a', 'b', 'c', 'd']);

        const restored = restoreProgress(next, snap);
        expect(restored.engine).toBe('insertion');
        expect(restored.done).toBe(false);
        return;
      }
      cur = next as InsertionState;
    }
    throw new Error('insertion sort did not complete');
  });
});

/**
 * Mirrors App.tsx undo wiring: one `snapshotProgress` push per pick/hide,
 * then `restoreProgress` pops exactly one frame. Normalization must not
 * add a second frame for the same user action.
 */
describe('App undo protocol (single frame per action)', () => {
  it('counts one undo frame per pick through insertion completion', () => {
    const { state: ins0 } = buildInsertionState({
      sortedItems: [A, B],
      pendingItems: [C, D],
    });
    let cur: SortState = ins0;
    const ring: SortProgress[] = [];
    let safety = 50;
    while (!cur.done && safety-- > 0) {
      const pair = getPair(cur);
      if (!pair) break;
      ring.push(snapshotProgress(cur));
      cur =
        pair.leftId <= pair.rightId
          ? enginePickLeft(cur)
          : enginePickRight(cur);
    }
    expect(cur.engine).toBe('merge');
    expect(cur.done).toBe(true);
    expect(ring.length).toBeGreaterThan(0);

    const afterOneUndo = restoreProgress(cur, ring[ring.length - 1]!);
    expect(afterOneUndo.done).toBe(false);
    expect(afterOneUndo.engine).toBe('insertion');
  });

  it('counts one undo frame for merge completion picks', () => {
    let cur: MergeState = initSort([A, B]);
    const ring: SortProgress[] = [];
    let safety = 20;
    while (!cur.done && safety-- > 0) {
      const pair = getPair(cur);
      if (!pair) break;
      ring.push(snapshotProgress(cur));
      cur = (
        pair.leftId <= pair.rightId
          ? enginePickLeft(cur)
          : enginePickRight(cur)
      ) as MergeState;
    }
    expect(cur.done).toBe(true);
    expect(cur.engine).toBe('merge');

    const afterOneUndo = restoreProgress(cur, ring[ring.length - 1]!);
    expect(afterOneUndo.done).toBe(false);
    expect(afterOneUndo.engine).toBe('merge');
  });

  it('hide that completes insertion costs one undo frame', () => {
    const { state: ins0 } = buildInsertionState({
      sortedItems: [A, B],
      pendingItems: [C],
    });
    const snap = snapshotProgress(ins0);
    const next = hideItem(ins0, 'c');
    expect(next.engine).toBe('merge');
    expect(next.done).toBe(true);

    const restored = restoreProgress(next, snap);
    expect(restored.engine).toBe('insertion');
    expect(restored.done).toBe(false);
    if (restored.engine === 'insertion') {
      expect(restored.current?.insertingId).toBe('c');
    }
  });
});

describe('updateItem (metadata edit)', () => {
  // Reusable items with full metadata so we can verify clears + edits.
  const withMeta: Item = {
    id: 'a',
    label: 'Foo',
    url: 'https://foo.example',
    imageUrl: 'https://img.example/foo.png',
  };

  it('updates label / url / imageUrl on a merge state, preserves structure', () => {
    const m = initSort([withMeta, B, C]);
    const next = updateItem(m, 'a', {
      label: 'Foo, Inc',
      url: 'https://foo-inc.example',
    });
    expect(next.items.a.label).toBe('Foo, Inc');
    expect(next.items.a.url).toBe('https://foo-inc.example');
    // imageUrl untouched (patch didn't include it).
    expect(next.items.a.imageUrl).toBe('https://img.example/foo.png');
    // Structure preserved: queue / engine identity intact.
    expect(next.engine).toBe('merge');
    if (next.engine === 'merge' && m.engine === 'merge') {
      expect(next.queue).toEqual(m.queue);
      expect(next.current).toEqual(m.current);
    }
    // Id stays stable — that's the whole point (queue references it).
    expect(next.items.a.id).toBe('a');
  });

  it('updates an item on an insertion state without touching sorted[]', () => {
    const ins = seedAsSorted([withMeta, B, C]);
    const next = updateItem(ins, 'a', { label: 'Foo, Inc' });
    expect(next.items.a.label).toBe('Foo, Inc');
    expect(next.engine).toBe('insertion');
    if (next.engine === 'insertion' && ins.engine === 'insertion') {
      expect(next.sorted).toEqual(ins.sorted);
    }
  });

  it('treats empty-string url / imageUrl as a clear (back to undefined)', () => {
    const m = initSort([withMeta, B]);
    const cleared = updateItem(m, 'a', { url: '', imageUrl: '' });
    expect(cleared.items.a.url).toBeUndefined();
    expect(cleared.items.a.imageUrl).toBeUndefined();
    // Label untouched.
    expect(cleared.items.a.label).toBe('Foo');
  });

  it('trims whitespace on all fields', () => {
    const m = initSort([withMeta, B]);
    const next = updateItem(m, 'a', {
      label: '  Foo, Inc  ',
      url: '  https://x.example  ',
      imageUrl: '  ',
    });
    expect(next.items.a.label).toBe('Foo, Inc');
    expect(next.items.a.url).toBe('https://x.example');
    // imageUrl that becomes empty after trim is cleared.
    expect(next.items.a.imageUrl).toBeUndefined();
  });

  it('refuses to set a blank label (returns input state unchanged)', () => {
    const m = initSort([withMeta, B]);
    const next = updateItem(m, 'a', { label: '   ' });
    expect(next).toBe(m); // same reference — caller skips undo push
    expect(m.items.a.label).toBe('Foo'); // unchanged
  });

  it('returns the input state unchanged when the patch is a no-op', () => {
    const m = initSort([withMeta, B]);
    // Same values, just re-typed.
    const next = updateItem(m, 'a', {
      label: 'Foo',
      url: 'https://foo.example',
      imageUrl: 'https://img.example/foo.png',
    });
    expect(next).toBe(m);
  });

  it('returns the input state unchanged when the id is unknown', () => {
    const m = initSort([withMeta, B]);
    const next = updateItem(m, 'nope', { label: 'Whatever' });
    expect(next).toBe(m);
  });

  it('does not affect ids referenced by hidden / toBeInserted / sorted arrays', () => {
    // Hide A so it lives in hidden[]; then rename — hidden[] must still
    // contain 'a' (the id), not the label.
    const m0 = initSort([withMeta, B, C]) as MergeState;
    const m1 = hideItem(m0, 'a') as MergeState;
    expect(m1.hidden).toContain('a');
    const m2 = updateItem(m1, 'a', { label: 'Renamed' });
    expect(m2.engine).toBe('merge');
    if (m2.engine === 'merge') {
      expect(m2.hidden).toContain('a');
    }
    expect(m2.items.a.label).toBe('Renamed');
  });
});

describe('cross-engine undo (restoreProgress)', () => {
  it('undo from normalized completion restores the in-progress insertion snapshot', () => {
    const { state: ins0 } = buildInsertionState({
      sortedItems: [A, B],
      pendingItems: [C, D],
    });
    let cur = ins0;
    let insertionSnap = snapshotProgress(cur);
    let safety = 50;
    while (!cur.done && safety-- > 0) {
      const pair = getPair(cur);
      if (!pair) break;
      insertionSnap = snapshotProgress(cur);
      const next =
        pair.leftId <= pair.rightId
          ? enginePickLeft(cur)
          : enginePickRight(cur);
      if (next.done) {
        expect(next.engine).toBe('merge');
        expect(next.done).toBe(true);

        const restored = restoreProgress(next, insertionSnap);
        expect(restored.engine).toBe('insertion');
        expect(restored.done).toBe(false);
        return;
      }
      cur = next as InsertionState;
    }
    throw new Error('insertion sort did not complete');
  });
});

describe('updateItemId', () => {
  it('rekeys the items dict and updates item.id to match', () => {
    const m = initSort([A, B, C]);
    const next = updateItemId(m, 'a', 'alpha');
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.items.alpha).toBeDefined();
    expect(next.items.alpha.id).toBe('alpha');
    expect(next.items.a).toBeUndefined();
  });

  it('rewrites references inside merge queue + frame', () => {
    // Construct a merge state with a non-trivial frame: drive one pick
    // so `current` is populated and the queue still has work.
    let m: MergeState = initSort([A, B, C]);
    // After init, queue starts as singletons and the first pick pops
    // a pair into `current`. Hide a different item too so hidden[]
    // has content.
    m = hideItem(m, 'c') as MergeState;
    const initialPair = getPair(m);
    expect(initialPair).not.toBeNull();
    const renamed = updateItemId(m, 'a', 'alpha');
    expect(renamed).not.toBeNull();
    if (!renamed || renamed.engine !== 'merge') {
      throw new Error('expected merge state');
    }
    // Old id must NOT appear anywhere in the progress.
    const allMerge = [
      ...renamed.queue.flat(),
      ...(renamed.current?.left ?? []),
      ...(renamed.current?.right ?? []),
      ...(renamed.current?.merged ?? []),
      ...renamed.hidden,
      ...renamed.toBeInserted,
      ...renamed.pendingManualInserts,
    ];
    expect(allMerge).not.toContain('a');
    // 'c' stays in hidden — proves rename was surgical, not blanket.
    expect(renamed.hidden).toContain('c');
  });

  it('rewrites references inside insertion sorted + pending + current', () => {
    const ins = seedAsSorted([A, B, C]) as InsertionState;
    // Push some pending so `current` is populated.
    const { state: withPending } = insertionAddItems(ins, [X, Y]);
    expect(withPending.current?.insertingId).toBe('x');

    const renamed = updateItemId(withPending, 'b', 'beta');
    expect(renamed).not.toBeNull();
    if (!renamed || renamed.engine !== 'insertion') {
      throw new Error('expected insertion state');
    }
    expect(renamed.sorted).toContain('beta');
    expect(renamed.sorted).not.toContain('b');
    // current.insertingId untouched ('x', not 'b'), pending stays put.
    expect(renamed.current?.insertingId).toBe('x');
    expect(renamed.pending).toEqual(['y']);
  });

  it('rejects empty / collision / unknown ids by returning null', () => {
    const m = initSort([A, B, C]);
    expect(updateItemId(m, 'a', '')).toBeNull();        // empty
    expect(updateItemId(m, 'a', '   ')).toBeNull();     // empty after trim
    expect(updateItemId(m, 'a', 'b')).toBeNull();       // collision
    expect(updateItemId(m, 'nope', 'alpha')).toBeNull(); // unknown old
  });

  it('returns input state unchanged when newId === oldId (no undo needed)', () => {
    const m = initSort([A, B, C]);
    expect(updateItemId(m, 'a', 'a')).toBe(m);
  });

  it('trims whitespace on newId before applying', () => {
    const m = initSort([A, B]);
    const next = updateItemId(m, 'a', '  alpha  ');
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.items.alpha).toBeDefined();
    expect(next.items['  alpha  ']).toBeUndefined();
  });

  it('accepts any non-empty trimmed string (CJK, emoji, etc.)', () => {
    const m = initSort([A, B]);
    const next = updateItemId(m, 'a', 'かぐや-s1');
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.items['かぐや-s1']).toBeDefined();
    expect(next.items['かぐや-s1'].id).toBe('かぐや-s1');
  });

  it('rewrites refs inside currentManualInsert (insertingId + frame.insertingId)', () => {
    // Set up an toBeInserted item, then click Insert to populate
    // currentManualInsert. The setup follows queueMergeSort's own
    // "drainManualInserts installs the frame immediately when no
    // merge is running" test: hide X mid-merge → X exiled to
    // toBeInserted → done → manualInsert(s, 'x') installs the frame.
    const X: Item = { id: 'x', label: 'X' };
    let s: MergeState = initSort([A, B, X]);
    s = mergeHideItem(s, 'x') as MergeState;
    // Drive the merge to completion via the alphabetic oracle.
    while (!s.done) {
      const p = getPair(s);
      if (!p) break;
      s = (p.leftId <= p.rightId ? pickLeft(s) : pickRight(s)) as MergeState;
    }
    expect(s.toBeInserted).toEqual(['x']);
    s = manualInsert(s, 'x') as MergeState;
    expect(s.currentManualInsert?.insertingId).toBe('x');
    expect(s.currentManualInsert?.frame.insertingId).toBe('x');

    // Rename 'x' → 'xenon'. Both insertingId fields on the frame
    // must rewrite, AND the items dict must rekey so the in-flight
    // pair shown by getPair resolves to a non-null item.
    const renamed = updateItemId(s, 'x', 'xenon');
    expect(renamed).not.toBeNull();
    if (!renamed || renamed.engine !== 'merge') {
      throw new Error('expected merge state');
    }
    expect(renamed.currentManualInsert?.insertingId).toBe('xenon');
    expect(renamed.currentManualInsert?.frame.insertingId).toBe('xenon');
    expect(renamed.items.xenon).toBeDefined();
    expect(renamed.items.x).toBeUndefined();
    // The in-flight pair must point at the renamed item — otherwise
    // the RANK tab would render a blank chip after the rename.
    const pair = getPair(renamed);
    expect(pair?.leftId).toBe('xenon');
    expect(renamed.items[pair!.leftId]).toBeDefined();
  });

  it('rewrites refs inside currentAutoInsert (target + pendingInserts + frame.insertingId)', () => {
    // 2-into-8 triggers auto-insert (insert cost 2·⌈log₂10⌉=8 < merge
    // cost 2+8-1=9), and 2 items on the smaller side means one lands
    // in `frame.insertingId` and the other queues into
    // `pendingInserts`. So this single setup exercises all three
    // ItemId-referencing fields on currentAutoInsert in one go.
    const items: Item[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
      (id) => ({ id, label: id.toUpperCase() }),
    );
    const X: Item = { id: 'x', label: 'X' };
    const Y2: Item = { id: 'y', label: 'Y' };
    const s = seedFromSublists({
      sublists: [items, [X, Y2]],
      extras: [],
    }) as MergeState;
    expect(s.currentAutoInsert).not.toBeNull();
    expect(s.currentAutoInsert!.target).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
    ]);
    expect(s.currentAutoInsert!.frame?.insertingId).toBe('x');
    expect(s.currentAutoInsert!.pendingInserts).toEqual(['y']);

    // Rename one id from EACH of the three reference sites so a single
    // pass would miss at least one if the rewriter dropped any field.
    let r = updateItemId(s, 'c', 'gamma') as MergeState;
    r = updateItemId(r, 'x', 'xenon') as MergeState;
    r = updateItemId(r, 'y', 'yttrium') as MergeState;
    expect(r.currentAutoInsert!.target).toEqual([
      'a', 'b', 'gamma', 'd', 'e', 'f', 'g', 'h',
    ]);
    expect(r.currentAutoInsert!.frame?.insertingId).toBe('xenon');
    expect(r.currentAutoInsert!.pendingInserts).toEqual(['yttrium']);
    expect(r.items.gamma).toBeDefined();
    expect(r.items.xenon).toBeDefined();
    expect(r.items.yttrium).toBeDefined();
    expect(r.items.c).toBeUndefined();
    expect(r.items.x).toBeUndefined();
    expect(r.items.y).toBeUndefined();
  });
});

describe('rewriteIdInProgress (used by App.tsx to fix the undo ring)', () => {
  it('returns same progress when oldId === newId', () => {
    const m = initSort([A, B, C]);
    const snap = snapshotProgress(m);
    expect(rewriteIdInProgress(snap, 'a', 'a')).toBe(snap);
  });

  it('rewriting then restoring an old snapshot via the rewritten ring keeps refs consistent', () => {
    // Simulates what App.tsx does: it has a SortState plus an undo
    // ring of progress snapshots. When the user renames id "a" →
    // "alpha", App.tsx maps every snapshot through rewriteIdInProgress
    // so undo doesn't restore an arrays-reference-old-id /
    // dict-keyed-by-new-id mismatch.
    //
    // Walk: take a merge snapshot, rename in the live state, rewrite
    // the snapshot, then restore the snapshot onto the renamed state
    // and verify the restored progress only references 'alpha'.
    const m = initSort([A, B, C]);
    const earlierSnap = snapshotProgress(m);
    const renamed = updateItemId(m, 'a', 'alpha');
    if (!renamed) throw new Error('rename failed');
    const rewrittenSnap = rewriteIdInProgress(earlierSnap, 'a', 'alpha');
    const restored = restoreProgress(renamed, rewrittenSnap);
    expect(restored.engine).toBe('merge');
    if (restored.engine !== 'merge') return;
    // 'alpha' must be reachable via the items dict (still keyed by
    // 'alpha' from the rename) AND referenced by the restored queue.
    expect(restored.items.alpha).toBeDefined();
    const all = [
      ...restored.queue.flat(),
      ...(restored.current?.left ?? []),
      ...(restored.current?.right ?? []),
      ...(restored.current?.merged ?? []),
    ];
    expect(all).toContain('alpha');
    expect(all).not.toContain('a');
  });
});
