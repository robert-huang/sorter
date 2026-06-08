import { describe, expect, it } from 'vitest';
import {
  addItem,
  comparisonsRemaining,
  getPair,
  getRanking,
  hideItem,
  initInsertionSort,
  pickLeft,
  pickRight,
  restoreProgress,
  seedInsertionFromSublists,
  snapshotProgress,
} from '../insertionSort';
import type { InsertionState, Item } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };
const F: Item = { id: 'f', label: 'F' };
const G: Item = { id: 'g', label: 'G' };
const H: Item = { id: 'h', label: 'H' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };
const Z: Item = { id: 'z', label: 'Z' };
const P: Item = { id: 'p', label: 'P' };

/**
 * Drive the sort by always picking the side whose head id ranks better in
 * `desiredOrder` (lower index = better). Returns the finished state plus
 * the number of prompts (= actual comparisons) the user answered.
 */
function runWithOracle(
  initial: InsertionState,
  desiredOrder: string[],
): { state: InsertionState; prompts: number } {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let prompts = 0;
  let safety = 500;
  while (!s.done && safety-- > 0) {
    const pair = getPair(s);
    if (!pair) break;
    const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = lr <= rr ? pickLeft(s) : pickRight(s);
    prompts += 1;
  }
  return { state: s, prompts };
}

/**
 * Drive the oracle but record, for each item, the [lo, hi] bounds of its
 * frame at the moment it is FIRST installed (before any pick narrows it).
 * Items that land with zero comparisons never become `current` and so are
 * absent from the map — itself evidence they were fully bounded.
 */
function runCapturingInstallBounds(
  initial: InsertionState,
  desiredOrder: string[],
): {
  state: InsertionState;
  prompts: number;
  installLo: Map<string, number>;
} {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let prompts = 0;
  const installLo = new Map<string, number>();
  let safety = 500;
  while (!s.done && safety-- > 0) {
    if (s.current && !installLo.has(s.current.insertingId)) {
      installLo.set(s.current.insertingId, s.current.lo);
    }
    const pair = getPair(s);
    if (!pair) break;
    const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = lr <= rr ? pickLeft(s) : pickRight(s);
    prompts += 1;
  }
  return { state: s, prompts, installLo };
}

/** Step the oracle until `targetId` is the in-flight inserting item. */
function driveUntilInserting(
  initial: InsertionState,
  desiredOrder: string[],
  targetId: string,
): InsertionState {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let safety = 500;
  while (!s.done && safety-- > 0) {
    if (s.current?.insertingId === targetId) return s;
    const pair = getPair(s);
    if (!pair) break;
    const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = lr <= rr ? pickLeft(s) : pickRight(s);
  }
  return s;
}

describe('initInsertionSort (flat from scratch)', () => {
  it('sorts a flat list to the oracle order', () => {
    const s0 = initInsertionSort([C, A, D, B, E], { shuffle: false });
    expect(s0.engine).toBe('insertion');
    // No runs on the flat path.
    expect(s0.pendingRunIds).toBeUndefined();
    const { state, prompts } = runWithOracle(s0, ['a', 'b', 'c', 'd', 'e']);
    expect(state.done).toBe(true);
    expect(getRanking(state)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // The worst-case budget is a valid upper bound on actual prompts.
    expect(prompts).toBeLessThanOrEqual(s0.totalComparisonsEverNeeded);
  });

  it('with a single item is immediately done', () => {
    const s0 = initInsertionSort([A], { shuffle: false });
    expect(s0.done).toBe(true);
    expect(getRanking(s0)).toEqual(['a']);
  });
});

describe('seedInsertionFromSublists', () => {
  it('uses the LARGEST sublist as the frozen seed', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[X, Y, Z], [A, B, C, D, E]], extras: [] },
      { shuffle: false },
    );
    // The 5-item sublist seeds `sorted`; the 3-item sublist drains. The
    // first run item (x) is already popped into `current` (in flight), so
    // pending / pendingRunIds list only what's still waiting.
    expect(state.sorted).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(state.current?.insertingId).toBe('x');
    expect(state.pending).toEqual(['y', 'z']);
    // It is a real run (3 items) so tightening metadata is present.
    expect(state.pendingRunIds).toEqual([0, 0]);
  });

  it('omits run ids when no non-seed sublist has 2+ items', () => {
    // One sublist (the seed) + extras → every pending item is a singleton.
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C]], extras: [X, Y] },
      { shuffle: false },
    );
    expect(state.sorted).toEqual(['a', 'b', 'c']);
    expect(state.pendingRunIds).toBeUndefined();
  });

  it('tightens the lower bound for later items in a pre-ranked run', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    // Oracle: x near the top, y and z progressively lower — a valid
    // best→worst run.
    const desired = ['a', 'x', 'b', 'c', 'y', 'd', 'z', 'e'];
    const { state: done, installLo } = runCapturingInstallBounds(state, desired);
    expect(done.done).toBe(true);
    expect(getRanking(done)).toEqual(desired);
    // First run item searches the full range...
    expect(installLo.get('x')).toBe(0);
    // ...later run items start AFTER where the previous one landed.
    const xIdx = done.sorted.indexOf('x');
    const yIdx = done.sorted.indexOf('y');
    expect(installLo.get('y')).toBe(xIdx + 1);
    expect(installLo.get('z')).toBe(yIdx + 1);
  });

  it('resets the anchor between a run and a following singleton', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D], [X, Y]], extras: [P] },
      { shuffle: false },
    );
    // x is in flight (run 0); y (run 0) and p (run 1) are still waiting.
    expect(state.current?.insertingId).toBe('x');
    expect(state.pendingRunIds).toEqual([0, 1]);
    // x near top, y lower (run), p lands BEFORE y → only a reset lets p
    // search the full range; a stale anchor would force it after y.
    const desired = ['a', 'x', 'b', 'p', 'c', 'y', 'd'];
    const { state: done, installLo } = runCapturingInstallBounds(state, desired);
    expect(getRanking(done)).toEqual(desired);
    expect(installLo.get('x')).toBe(0);
    expect(installLo.get('y')).toBe(done.sorted.indexOf('x') + 1);
    // p is a fresh run → full range despite y landing late.
    expect(installLo.get('p')).toBe(0);
  });

  it('needs far fewer comparisons than the same items added flat', () => {
    const seed = [A, B, C, D, E, F, G, H];
    const run = [X, Y, Z];
    const desired = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x', 'y', 'z'];

    const preranked = seedInsertionFromSublists(
      { sublists: [seed, run], extras: [] },
      { shuffle: false },
    ).state;
    const flat = seedInsertionFromSublists(
      { sublists: [seed], extras: run },
      { shuffle: false },
    ).state;

    const pre = runWithOracle(preranked, desired);
    const fl = runWithOracle(flat, desired);

    expect(getRanking(pre.state)).toEqual(desired);
    expect(getRanking(fl.state)).toEqual(desired);
    // Tightening collapses the trailing run inserts to ~zero probes.
    expect(pre.prompts).toBeLessThan(fl.prompts);
  });
});

describe('insertion run tracking under edits', () => {
  it('removing the in-flight run item keeps the next one tightened', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    const desired = ['a', 'x', 'b', 'y', 'c', 'z', 'd', 'e'];
    // Drive until y is the in-flight item, then drop it.
    const atY = driveUntilInserting(state, desired, 'y');
    expect(atY.current?.insertingId).toBe('y');
    const afterHide = hideItem(atY, 'y');
    // y is gone; z drains next and is STILL bounded by x's landing
    // position (the anchor survives — y simply never landed).
    expect(afterHide.current?.insertingId).toBe('z');
    expect(afterHide.current?.lo).toBe(afterHide.sorted.indexOf('x') + 1);
    const { state: done } = runWithOracle(afterHide, desired);
    expect(getRanking(done)).not.toContain('y');
    expect(getRanking(done)).toEqual(['a', 'x', 'b', 'c', 'z', 'd', 'e']);
  });

  it('removing a waiting run item keeps run ids parallel to pending', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    // x is in flight; y and z are waiting in run 0.
    expect(state.pending).toEqual(['y', 'z']);
    expect(state.pendingRunIds).toEqual([0, 0]);
    const next = hideItem(state, 'y');
    expect(next.pending).toEqual(['z']);
    expect(next.pendingRunIds).toEqual([0]);
  });

  it('added items append as full-range singleton runs', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D], [X, Y]], extras: [] },
      { shuffle: false },
    );
    const withP = addItem(state, P);
    expect(withP).not.toBeNull();
    // P gets a fresh run id distinct from the existing run 0.
    expect(withP!.pendingRunIds).toEqual([0, 1]);
  });
});

describe('snapshot/restore carries run metadata', () => {
  it('round-trips pendingRunIds / activeRunId / activeRunAnchor', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    // Advance into the run so the anchor fields are populated.
    const mid = driveUntilInserting(state, ['a', 'x', 'b', 'y', 'c', 'z', 'd', 'e'], 'y');
    const snap = snapshotProgress(mid);
    expect(snap.activeRunId).toBe(0);
    expect(typeof snap.activeRunAnchor).toBe('number');
    const restored = restoreProgress(mid, snap);
    expect(restored.pendingRunIds).toEqual(mid.pendingRunIds);
    expect(restored.activeRunId).toBe(mid.activeRunId);
    expect(restored.activeRunAnchor).toBe(mid.activeRunAnchor);
    // Mutating the restored array must not bleed into the snapshot.
    restored.pendingRunIds?.push(99);
    expect(snap.pendingRunIds).not.toEqual(restored.pendingRunIds);
  });
});

describe('estimate stays a valid upper bound with tightening', () => {
  it('never undercounts despite rank-aware bounds', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    const budget = state.totalComparisonsEverNeeded;
    const desired = ['a', 'x', 'b', 'c', 'y', 'd', 'z', 'e'];
    const { state: done, prompts } = runWithOracle(state, desired);
    expect(done.done).toBe(true);
    // Actual comparisons never exceed the initial worst-case budget.
    expect(prompts).toBeLessThanOrEqual(budget);
    expect(comparisonsRemaining(done)).toBe(0);
  });
});
