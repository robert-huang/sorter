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
const Q: Item = { id: 'q', label: 'Q' };

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
  it('uses the first sublist as the frozen seed regardless of size', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[X, Y, Z], [A, B, C, D, E]], extras: [] },
      { shuffle: false },
    );
    // The first 3-item sublist seeds `sorted`; the larger sublist drains. The
    // first run item (a) is already popped into `current` (in flight), so
    // pending / pendingRunIds list only what's still waiting.
    expect(state.sorted).toEqual(['x', 'y', 'z']);
    expect(state.current?.insertingId).toBe('a');
    // Remaining endpoints alternate worst/best while the canonical source
    // order remains available separately for LIST.
    expect(state.pending).toEqual(['e', 'b', 'd', 'c']);
    expect(state.pendingRunIds).toEqual([0, 0, 0, 0]);
    expect(state.activeRunAlternatingBounds).toBe(true);
    expect(state.activeRunUpperAnchorId).toBe('e');
    expect(state.activeRunSourceIds).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('shuffles whole ranked runs with loose-item singleton runs', () => {
    const { state } = seedInsertionFromSublists(
      {
        sublists: [[A, B], [X, Y, Z]],
        extras: [P],
      },
      { random: () => 0 },
    );

    expect(state.sorted).toEqual(['a', 'b']);
    // Fisher–Yates moves the loose singleton ahead of the ranked run.
    expect(state.current?.insertingId).toBe('p');
    expect(state.pending).toEqual(['x', 'y', 'z']);
    // The ranked sublist remains one contiguous tightening run.
    expect(state.pendingRunIds).toEqual([0, 0, 0]);
  });

  it('initializes each queued pre-ranked run with its own alternating order', () => {
    const R: Item = { id: 'r', label: 'R' };
    const S: Item = { id: 's', label: 'S' };
    const T: Item = { id: 't', label: 'T' };
    const { state } = seedInsertionFromSublists(
      {
        sublists: [[A, B, C, D, E, F, G, H], [X, Y, Z], [P, Q, R, S, T]],
        extras: [],
      },
      { shuffle: false },
    );
    const desired = [
      'x',
      'y',
      'z',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'p',
      'q',
      'r',
      's',
      't',
    ];

    const atP = driveUntilInserting(state, desired, 'p');
    expect(atP.current?.insertingId).toBe('p');
    expect(atP.activeRunSourceIds).toEqual(['p', 'q', 'r', 's', 't']);
    expect(atP.pending).toEqual(['t', 'q', 's', 'r']);

    const result = runWithOracle(atP, desired);
    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
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

  it('places both endpoints before draining a pre-ranked run interior', () => {
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
    // First run item searches the full range.
    expect(installLo.get('x')).toBe(0);
    // The worst endpoint is inserted second from immediately after X.
    const xIdx = done.sorted.indexOf('x');
    expect(installLo.get('z')).toBe(xIdx + 1);
    // The interior then reuses X as its lower endpoint; Z remains the
    // upper endpoint rather than replacing the lower anchor.
    expect(installLo.get('y')).toBe(xIdx + 1);
  });

  it('uses the placed worst endpoint as the interior upper bound', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    const desired = ['a', 'x', 'b', 'c', 'y', 'd', 'z', 'e'];
    const atY = driveUntilInserting(state, desired, 'y');

    expect(atY.current?.insertingId).toBe('y');
    expect(atY.activeRunUpperAnchorId).toBe('z');
    expect(atY.current?.lo).toBe(atY.sorted.indexOf('x') + 1);
    expect(atY.current?.hi).toBe(atY.sorted.indexOf('z') - 1);
  });

  it('advances both landed bounds while alternating a five-item run', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E, F, G, H], [X, Y, Z, P, Q]], extras: [] },
      { shuffle: false },
    );
    const desired = [
      'a',
      'x',
      'b',
      'y',
      'c',
      'z',
      'd',
      'p',
      'e',
      'q',
      'f',
      'g',
      'h',
    ];

    expect(state.current?.insertingId).toBe('x');
    expect(state.pending).toEqual(['q', 'y', 'p', 'z']);

    const atQ = driveUntilInserting(state, desired, 'q');
    expect(atQ.current?.lo).toBe(atQ.sorted.indexOf('x') + 1);

    const atY = driveUntilInserting(atQ, desired, 'y');
    expect(atY.activeRunUpperAnchorId).toBe('q');
    expect(atY.current?.lo).toBe(atY.sorted.indexOf('x') + 1);
    expect(atY.current?.hi).toBe(atY.sorted.indexOf('q') - 1);

    const atP = driveUntilInserting(atY, desired, 'p');
    expect(atP.activeRunAnchor).toBe(atP.sorted.indexOf('y'));
    expect(atP.current?.lo).toBe(atP.sorted.indexOf('y') + 1);
    expect(atP.current?.hi).toBe(atP.sorted.indexOf('q') - 1);

    const atZ = driveUntilInserting(atP, desired, 'z');
    expect(atZ.activeRunUpperAnchorId).toBe('p');
    expect(atZ.current?.lo).toBe(atZ.sorted.indexOf('y') + 1);
    expect(atZ.current?.hi).toBe(atZ.sorted.indexOf('p') - 1);

    const result = runWithOracle(atZ, desired);
    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
  });

  it('collapses a contiguous 50-item run after its endpoints land', () => {
    const anchor = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `anchor-${index + 1}`,
        label: `Anchor ${index + 1}`,
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `anchor-${index + 101}`,
        label: `Anchor ${index + 101}`,
      })),
    ];
    const run = Array.from({ length: 50 }, (_, index) => ({
      id: `run-${index + 51}`,
      label: `Run ${index + 51}`,
    }));
    const desired = [
      ...anchor.slice(0, 50).map((item) => item.id),
      ...run.map((item) => item.id),
      ...anchor.slice(50).map((item) => item.id),
    ];
    const state = seedInsertionFromSublists(
      { sublists: [anchor, run], extras: [] },
      { shuffle: false },
    ).state;

    const result = runWithOracle(state, desired);

    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
    expect(result.prompts).toBe(11);
  });

  it('preserves correctness and forecast bounds for every 5-into-4 interleaving', () => {
    const anchor = Array.from({ length: 4 }, (_, index) => ({
      id: `anchor-${index}`,
      label: `Anchor ${index}`,
    }));
    const run = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index}`,
      label: `Run ${index}`,
    }));
    const runPositions: number[][] = [];
    const collectPositions = (
      start: number,
      remaining: number,
      selected: number[],
    ): void => {
      if (remaining === 0) {
        runPositions.push([...selected]);
        return;
      }
      for (let index = start; index <= 9 - remaining; index++) {
        selected.push(index);
        collectPositions(index + 1, remaining - 1, selected);
        selected.pop();
      }
    };
    collectPositions(0, run.length, []);

    for (const positions of runPositions) {
      const runPositionSet = new Set(positions);
      const desired: string[] = [];
      let anchorIndex = 0;
      let runIndex = 0;
      for (let index = 0; index < anchor.length + run.length; index++) {
        desired.push(
          runPositionSet.has(index)
            ? run[runIndex++].id
            : anchor[anchorIndex++].id,
        );
      }
      const state = seedInsertionFromSublists(
        { sublists: [anchor, run], extras: [] },
        { shuffle: false },
      ).state;
      const result = runWithOracle(state, desired);
      expect(getRanking(result.state)).toEqual(desired);
      expect(result.prompts).toBeLessThanOrEqual(
        state.totalComparisonsEverNeeded,
      );
    }
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

  it('uses fewer probes than fixed-upper draining across multiple outliers', () => {
    const anchor = Array.from({ length: 64 }, (_, index) => ({
      id: `anchor-${index}`,
      label: `Anchor ${index}`,
    }));
    const run = Array.from({ length: 8 }, (_, index) => ({
      id: `run-${index}`,
      label: `Run ${index}`,
    }));
    // The final two run items are progressively separated from the leading
    // cluster. Alternation lands both as useful upper bounds before the
    // middle of the run drains.
    const runRanks = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 13.5, 24.5];
    const desired = [
      ...anchor.map((item, index) => ({ id: item.id, rank: index * 2 })),
      ...run.map((item, index) => ({ id: item.id, rank: runRanks[index] })),
    ]
      .sort((left, right) => left.rank - right.rank)
      .map(({ id }) => id);
    const alternating = seedInsertionFromSublists(
      { sublists: [anchor, run], extras: [] },
      { shuffle: false },
    ).state;
    const fixedUpper = {
      ...alternating,
      pending: [
        run[run.length - 1].id,
        ...run.slice(1, -1).map((item) => item.id),
      ],
      activeRunAlternatingBounds: false,
    };

    const alternatingResult = runWithOracle(alternating, desired);
    const fixedUpperResult = runWithOracle(fixedUpper, desired);

    expect(getRanking(alternatingResult.state)).toEqual(desired);
    expect(getRanking(fixedUpperResult.state)).toEqual(desired);
    expect(alternatingResult.prompts).toBeLessThan(fixedUpperResult.prompts);
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
    // Z was already placed as the upper endpoint. Removing the sole
    // interior item therefore completes the run immediately.
    expect(afterHide.current).toBeNull();
    expect(afterHide.done).toBe(true);
    const { state: done } = runWithOracle(afterHide, desired);
    expect(getRanking(done)).not.toContain('y');
    expect(getRanking(done)).toEqual(['a', 'x', 'b', 'c', 'z', 'd', 'e']);
  });

  it('removing a waiting run item keeps run ids parallel to pending', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    // x is in flight; z is the queued upper endpoint and y the interior.
    expect(state.pending).toEqual(['z', 'y']);
    expect(state.pendingRunIds).toEqual([0, 0]);
    const next = hideItem(state, 'y');
    expect(next.pending).toEqual(['z']);
    expect(next.pendingRunIds).toEqual([0]);
  });

  it('keeps alternating bounds sound after a waiting interior endpoint is hidden', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E, F], [X, Y, Z, P, Q]], extras: [] },
      { shuffle: false },
    );
    expect(state.pending).toEqual(['q', 'y', 'p', 'z']);

    const withoutP = hideItem(state, 'p');
    expect(withoutP.pending).toEqual(['q', 'y', 'z']);
    expect(withoutP.pendingRunIds).toEqual([0, 0, 0]);
    expect(withoutP.activeRunSourceIds).toEqual(['x', 'y', 'z', 'q']);

    const desired = ['a', 'x', 'b', 'y', 'c', 'z', 'd', 'q', 'e', 'f'];
    const result = runWithOracle(withoutP, desired);
    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
  });

  it('falls back to lower-bound tightening when the queued upper endpoint is hidden', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    expect(state.pending).toEqual(['z', 'y']);

    const withoutUpper = hideItem(state, 'z');

    expect(withoutUpper.activeRunUpperAnchorId).toBeNull();
    expect(withoutUpper.pending).toEqual(['y']);
    const desired = ['a', 'x', 'b', 'c', 'y', 'd', 'e'];
    const result = runWithOracle(withoutUpper, desired);
    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
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
  it('round-trips run ids, strategy, anchors, and the full active source', () => {
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
    expect(restored.activeRunAlternatingBounds).toBe(true);
    expect(restored.activeRunUpperAnchorId).toBe('z');
    expect(restored.activeRunSourceIds).toEqual(['x', 'y', 'z']);
    // Mutating the restored array must not bleed into the snapshot.
    restored.pendingRunIds?.push(99);
    expect(snap.pendingRunIds).not.toEqual(restored.pendingRunIds);
    restored.activeRunSourceIds?.push('p');
    expect(snap.activeRunSourceIds).not.toEqual(restored.activeRunSourceIds);
  });

  it('continues legacy fixed-upper saves when the strategy marker is absent', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[X, Y, Z], [A, B, C, D, E]], extras: [] },
      { shuffle: false },
    );
    const {
      activeRunAlternatingBounds: _strategy,
      ...legacySnapshot
    } = snapshotProgress(state);
    legacySnapshot.pending = ['e', 'b', 'c', 'd'];

    const restored = restoreProgress(state, legacySnapshot);
    expect(restored.activeRunAlternatingBounds).toBeUndefined();
    expect(restored.pending).toEqual(['e', 'b', 'c', 'd']);

    const desired = ['x', 'a', 'y', 'b', 'c', 'd', 'z', 'e'];
    const result = runWithOracle(restored, desired);
    expect(result.state.done).toBe(true);
    expect(getRanking(result.state)).toEqual(desired);
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

  it('drops the remaining estimate once both ranked endpoints land', () => {
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B], [X, Y, Z]], extras: [] },
      { shuffle: false },
    );
    const desired = ['a', 'x', 'z', 'y', 'b'];
    const rank = new Map(desired.map((id, index) => [id, index]));
    let s = driveUntilInserting(state, desired, 'z');
    while (s.current?.insertingId === 'z') {
      const pair = getPair(s);
      if (!pair) break;
      const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = leftRank <= rightRank ? pickLeft(s) : pickRight(s);
    }
    // Endpoints are adjacent; the sole interior item auto-splices with no probes.
    expect(s.sorted).toContain('z');
    expect(s.sorted).toContain('y');
    expect(s.pending).toEqual([]);
    expect(s.current).toBeNull();
    expect(comparisonsRemaining(s)).toBe(0);
  });

  it('never undercounts mid-run when endpoints bracket a wide interior window', () => {
    const V: Item = { id: 'v', label: 'V' };
    const W: Item = { id: 'w', label: 'W' };
    const { state } = seedInsertionFromSublists(
      { sublists: [[A, B, C, D, E], [X, V, Y, W, Z]], extras: [] },
      { shuffle: false },
    );
    const desired = ['a', 'x', 'b', 'v', 'c', 'y', 'd', 'w', 'z', 'e'];
    const rank = new Map(desired.map((id, i) => [id, i]));
    let s = state;
    let safety = 500;
    while (!s.done && safety-- > 0) {
      if (s.sorted.includes('z')) break;
      const pair = getPair(s);
      if (!pair) break;
      const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = leftRank <= rightRank ? pickLeft(s) : pickRight(s);
    }
    expect(s.sorted).toContain('x');
    expect(s.sorted).toContain('z');
    const remaining = comparisonsRemaining(s);
    const { prompts } = runWithOracle(s, desired);
    expect(prompts).toBeLessThanOrEqual(remaining);
  });
});
