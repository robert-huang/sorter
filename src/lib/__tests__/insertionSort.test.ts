import { describe, expect, it } from 'vitest';
import {
  addItem,
  addItems,
  buildInsertionState,
  comparisonsRemaining,
  dismissHidden,
  forgetHiddenItem,
  getPair,
  getPeekLeftIds,
  getPeekRightIds,
  getRanking,
  hideItem,
  pickLeft,
  pickRight,
  reorderInSorted,
  restoreProgress,
  restoreHiddenItem,
  returnToPending,
  seedAsSorted,
  snapshotProgress,
  unhideItem,
} from '../insertionSort';
import type { InsertionState, Item } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };
const Z: Item = { id: 'z', label: 'Z' };

function build(args: {
  sorted: Item[];
  pending: Item[];
}): InsertionState {
  return buildInsertionState({
    sortedItems: args.sorted,
    pendingItems: args.pending,
  }).state;
}

/**
 * Drive the sort by always picking the side whose head id has the lower
 * position in `desiredOrder` (so "lower position" = "better").
 */
function runWithOracle(
  initial: InsertionState,
  desiredOrder: string[],
): { state: InsertionState; prompts: number } {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let prompts = 0;
  let safety = 200;
  while (!s.done && safety-- > 0) {
    const pair = getPair(s);
    if (!pair) break;
    const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = leftRank <= rightRank ? pickLeft(s) : pickRight(s);
    prompts += 1;
  }
  return { state: s, prompts };
}

describe('seedAsSorted', () => {
  it('produces a done insertion-mode state with the given sorted order', () => {
    const s = seedAsSorted([A, B, C]);
    expect(s.engine).toBe('insertion');
    expect(s.sorted).toEqual(['a', 'b', 'c']);
    expect(s.pending).toEqual([]);
    expect(s.done).toBe(true);
    expect(s.comparisons).toBe(0);
    expect(s.totalComparisonsEverNeeded).toBe(0);
    expect(getRanking(s)).toEqual(['a', 'b', 'c']);
  });

  it('with 0 items is done immediately', () => {
    const s = seedAsSorted([]);
    expect(s.done).toBe(true);
    expect(getRanking(s)).toEqual([]);
  });
});

describe('buildInsertionState', () => {
  it('builds a sorted base + pending plan and installs the first probe', () => {
    const { state, skipped } = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    });
    expect(skipped).toEqual([]);
    expect(state.engine).toBe('insertion');
    expect(state.sorted).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(state.pending).toEqual([]); // pop-on-install moved x to current
    expect(state.current).not.toBeNull();
    expect(state.current!.insertingId).toBe('x');
    // Full range: lo=0, hi=4, probe=2 → midpoint
    expect(state.current!.lo).toBe(0);
    expect(state.current!.hi).toBe(4);
    expect(state.current!.probe).toBe(2);
    // Worst case for 1 insert into L=5: ceil(log2(6)) = 3
    expect(state.totalComparisonsEverNeeded).toBe(3);
  });

  it('dedups pending against sorted', () => {
    const { state, skipped } = buildInsertionState({
      sortedItems: [A, B, C],
      pendingItems: [B, X],
    });
    expect(skipped).toEqual(['b']);
    expect(state.current?.insertingId).toBe('x');
    expect(state.pending).toEqual([]); // x popped on install
  });

  it('drains free-splices (empty sorted, multi-pending) without prompting', () => {
    // sorted=[], pending=[a, b]. First insert is free (empty), second
    // installs a real frame and pops b from pending.
    const { state } = buildInsertionState({
      sortedItems: [],
      pendingItems: [A, B],
    });
    expect(state.sorted).toEqual(['a']);
    expect(state.pending).toEqual([]);
    expect(state.current).not.toBeNull();
    expect(state.current!.insertingId).toBe('b');
  });

  it('also installs the first probe when pending starts with items', () => {
    // sorted=[a..e], pending=[x]: after build, x is on `current` and
    // pending is empty (pop-on-install convention).
    const { state } = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    });
    expect(state.pending).toEqual([]);
    expect(state.current?.insertingId).toBe('x');
  });
});

describe('getPair', () => {
  it('returns insertingId on the left, probed sorted item on the right', () => {
    const s = build({ sorted: [A, B, C, D, E], pending: [X] });
    const pair = getPair(s);
    expect(pair).toEqual({ leftId: 'x', rightId: 'c' });
  });

  it('returns null when no frame is active (done state)', () => {
    const s = seedAsSorted([A, B, C]);
    expect(getPair(s)).toBeNull();
  });
});

describe('pick / FIFO drain', () => {
  it('lexicographic oracle places X = "cc" between C and D in [A..E] (2 prompts)', () => {
    const Cc: Item = { id: 'cc', label: 'Cc' };
    const s0 = build({ sorted: [A, B, C, D, E], pending: [Cc] });
    const { state, prompts } = runWithOracle(s0, [
      'a',
      'b',
      'c',
      'cc',
      'd',
      'e',
    ]);
    expect(state.done).toBe(true);
    expect(getRanking(state)).toEqual(['a', 'b', 'c', 'cc', 'd', 'e']);
    // ceil(log2(5+1)) = 3 is the worst case; concrete oracle should
    // need 3 here (probe at c → cc>c → lo=3, probe at d → cc<d → hi=2
    // → done. That's 2.
    expect(prompts).toBe(2);
  });

  it('drains FIFO with three pending items, no rank-aware optimization', () => {
    const s0 = build({ sorted: [A, B, C], pending: [X, Y, Z] });
    // Oracle: X best, A next, Y, B, C, Z worst → unusual order to
    // force the drain to do real work.
    const { state } = runWithOracle(s0, [
      'x', 'a', 'y', 'b', 'c', 'z',
    ]);
    expect(state.done).toBe(true);
    expect(getRanking(state)).toEqual(['x', 'a', 'y', 'b', 'c', 'z']);
  });

  it('comparisons grow by exactly 1 per pick', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    expect(s0.comparisons).toBe(0);
    const s1 = pickLeft(s0);
    expect(s1.comparisons).toBe(1);
  });
});

describe('comparisonsRemaining', () => {
  it('matches the seeded totalComparisonsEverNeeded at start', () => {
    const s = build({ sorted: [A, B, C, D, E], pending: [X, Y] });
    // L=5, K=2: i=0 → ceil(log2(6))=3; i=1 → ceil(log2(7))=3 → total 6
    expect(s.totalComparisonsEverNeeded).toBe(6);
    expect(comparisonsRemaining(s)).toBe(6);
  });

  it('monotonically descends through a deterministic oracle (modulo collapse jumps)', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    const seen = [comparisonsRemaining(s0)];
    let s = s0;
    let safety = 20;
    while (!s.done && safety-- > 0) {
      const p = getPair(s);
      if (!p) break;
      s = p.leftId <= p.rightId ? pickLeft(s) : pickRight(s);
      seen.push(comparisonsRemaining(s));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
    expect(comparisonsRemaining(s)).toBe(0);
  });
});

describe('snapshot / restore round-trip', () => {
  it('a pick can be undone exactly', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    const snap = snapshotProgress(s0);
    const s1 = pickLeft(s0);
    const restored = restoreProgress(s1, snap);
    expect(restored.current).toEqual(s0.current);
    expect(restored.comparisons).toBe(0);
    expect(restored.sorted).toEqual(s0.sorted);
    expect(restored.pending).toEqual(s0.pending);
    expect(restored.done).toBe(false);
  });

  it('done state round-trips with empty pending', () => {
    const s0 = seedAsSorted([A, B, C]);
    const snap = snapshotProgress(s0);
    expect(snap.engine).toBe('insertion');
    expect(snap.done).toBe(true);
    expect(snap.sorted).toEqual(['a', 'b', 'c']);
  });
});

describe('addItem (mid-plan)', () => {
  it('adds a new id and flips done back to false; first probe is installed', () => {
    const s0 = seedAsSorted([A, B, C]);
    expect(s0.done).toBe(true);
    const s1 = addItem(s0, X)!;
    expect(s1.done).toBe(false);
    // Drained: current frame for x; pop-on-install leaves pending empty.
    expect(s1.current).not.toBeNull();
    expect(s1.current!.insertingId).toBe('x');
    expect(s1.pending).toEqual([]);
  });

  it('refuses duplicates by id (returns null)', () => {
    const s0 = build({ sorted: [A, B], pending: [X] });
    expect(addItem(s0, A)).toBeNull();
    expect(addItem(s0, X)).toBeNull();
  });

  it('mid-insert: addItem does NOT interrupt the current frame', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    expect(s0.current?.insertingId).toBe('x');
    expect(s0.pending).toEqual([]);
    const beforeFrame = s0.current!;
    const s1 = addItem(s0, Y)!;
    // Same insertingId still in flight
    expect(s1.current?.insertingId).toBe('x');
    expect(s1.current?.lo).toBe(beforeFrame.lo);
    expect(s1.current?.hi).toBe(beforeFrame.hi);
    expect(s1.current?.probe).toBe(beforeFrame.probe);
    // Y waits at the back of pending; x already moved to current.
    expect(s1.pending).toEqual(['y']);
  });

  it('bumps totalComparisonsEverNeeded by the new item\'s cost', () => {
    // L=3, K=1 → total = ceil(log2(4)) = 2
    const s0 = build({ sorted: [A, B, C], pending: [X] });
    expect(s0.totalComparisonsEverNeeded).toBe(2);
    // Add Y → after X lands sorted becomes 4, Y needs ceil(log2(5))=3.
    // Total grows to 2 + 3 = 5.
    const s1 = addItem(s0, Y)!;
    expect(s1.totalComparisonsEverNeeded).toBe(5);
  });
});

describe('addItems (batch, v1 rank-blind)', () => {
  it('dedups + appends survivors to pending in input order', () => {
    const s0 = build({ sorted: [A, B], pending: [] });
    const { state, skipped } = addItems(s0, [B, X, A, Y]);
    expect(skipped).toEqual(['b', 'a']);
    // Survivors pushed in order; drainPending pops x onto current,
    // leaving y in pending.
    expect(state.current?.insertingId).toBe('x');
    expect(state.pending).toEqual(['y']);
  });

  it('per-item costs are independent (no rank-aware optimization in v1)', () => {
    // L=10, K=3 → 4 + 4 + 4 = 12
    const sortedItems = Array.from({ length: 10 }, (_, i) => ({
      id: String.fromCharCode(97 + i),
      label: String.fromCharCode(65 + i),
    }));
    const { state } = addItems(
      build({ sorted: sortedItems, pending: [] }),
      [X, Y, Z],
    );
    expect(state.totalComparisonsEverNeeded).toBe(12);
  });
});

describe('hide / unhide', () => {
  it('hide a pending (not-yet-running) item removes it and trims totals', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X, Y] });
    // L=5, K=2: after drain, current=frame_x (remaining=3), pending=[y]
    // (projected cost=3). Total budget = 6.
    expect(s0.totalComparisonsEverNeeded).toBe(6);
    expect(s0.current?.insertingId).toBe('x');
    expect(s0.pending).toEqual(['y']);
    const s1 = hideItem(s0, 'y');
    expect(s1.hidden).toContain('y');
    expect(s1.pending).toEqual([]);
    expect(s1.current?.insertingId).toBe('x');
    // Remaining drops by 3 (Y's projected cost) but
    // totalComparisonsEverNeeded is a running MAX so it stays at 6.
    expect(comparisonsRemaining(s1)).toBe(3);
    expect(s1.totalComparisonsEverNeeded).toBe(6);
  });

  it('hide the currently-inserting item cancels the frame and drains next', () => {
    const s0 = build({ sorted: [A, B, C], pending: [X, Y] });
    expect(s0.current?.insertingId).toBe('x');
    expect(s0.pending).toEqual(['y']);
    const s1 = hideItem(s0, 'x');
    expect(s1.current?.insertingId).toBe('y');
    expect(s1.pending).toEqual([]);
    expect(s1.hidden).toContain('x');
  });

  it('hide a sorted item is allowed; probe-skipping handles it', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    // hide c (the current probe). getPair should still produce
    // something via probe-skipping (or null if it collapsed).
    const s1 = hideItem(s0, 'c');
    expect(s1.hidden).toContain('c');
    // x is still being inserted; probe was at c → skip to next.
    const pair = getPair(s1);
    expect(pair?.leftId).toBe('x');
    expect(pair?.rightId).not.toBe('c');
  });

  it('unhide clears the hidden bit without re-running comparisons', () => {
    const s0 = build({ sorted: [A, B], pending: [X] });
    const s1 = hideItem(s0, 'a');
    expect(s1.hidden).toContain('a');
    const s2 = unhideItem(s1, 'a');
    expect(s2.hidden).toEqual([]);
  });

  it('hiding all pending while a frame is mid-flight: cancel + done', () => {
    const s0 = build({ sorted: [A, B], pending: [X] });
    expect(s0.current?.insertingId).toBe('x');
    const s1 = hideItem(s0, 'x');
    expect(s1.current).toBeNull();
    expect(s1.pending).toEqual([]);
    expect(s1.done).toBe(true);
  });

  it('hiding every probe in [lo, hi] resolves the frame instead of stalling', () => {
    // Regression for the "all-probes-hidden stall" bug. Pre-fix, after
    // hiding every visible probe the frame remained set with no visible
    // candidates: getPair returned null while state.done stayed false,
    // and the user saw the misleading empty-state "Add some items on
    // the START tab" with no path forward except undo.
    //
    // Now hideItem detects the collapsed range via skipHiddenProbes and
    // splices the inserting id at the resolved position itself.
    const s0 = build({ sorted: [A, B, C], pending: [X] });
    expect(s0.current?.insertingId).toBe('x');
    // Hide every item in sorted[]. The frame's [lo, hi] collapses to a
    // single virtual position with no visible candidates.
    let s = hideItem(s0, 'a');
    s = hideItem(s, 'b');
    s = hideItem(s, 'c');
    // x must have been spliced into sorted and the frame cleared.
    expect(s.current).toBeNull();
    expect(s.sorted).toContain('x');
    expect(s.pending).toEqual([]);
    // With no remaining work and an empty pending queue, the sort is done.
    expect(s.done).toBe(true);
    // getPair returns null because we're done, not because we stalled.
    expect(getPair(s)).toBeNull();
    // Visible ranking is just x (a/b/c are all hidden).
    expect(getRanking(s)).toEqual(['x']);
  });

  it('partial hide that still leaves a visible probe does not splice early', () => {
    // Sanity check: hiding *some* of the probes shouldn't trigger the
    // splice path — we only short-circuit when [lo, hi] has zero
    // visible candidates. With [A, B, C, D, E] and X being inserted,
    // hiding b still leaves a, c, d, e to probe against.
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    const s1 = hideItem(s0, 'b');
    expect(s1.current).not.toBeNull();
    expect(s1.current?.insertingId).toBe('x');
    expect(s1.sorted).not.toContain('x');
    expect(getPair(s1)).not.toBeNull();
  });
});

describe('reorderInSorted (Phase 1 freeze-relax)', () => {
  it('swaps adjacent items in the sorted list', () => {
    const s0 = seedAsSorted([A, B, C, D]);
    expect(s0.sorted).toEqual(['a', 'b', 'c', 'd']);
    const s1 = reorderInSorted(s0, 1, 1); // swap b and c
    expect(s1.sorted).toEqual(['a', 'c', 'b', 'd']);
    // No in-flight frame so no extra comparisons charged or pending churn.
    expect(s1.pending).toEqual([]);
    expect(s1.current).toBeNull();
  });

  it('rejects out-of-range indices', () => {
    const s0 = seedAsSorted([A, B]);
    expect(reorderInSorted(s0, 0, -1)).toBe(s0); // can't move head up
    expect(reorderInSorted(s0, 1, 1)).toBe(s0); // can't move tail down
    expect(reorderInSorted(s0, 5, 1)).toBe(s0); // out of range
  });

  it('cancels and restarts the in-flight insert frame', () => {
    // sorted=[A..E], pending=[X] → after build, X is on a frame
    // probing index 2 (the midpoint).
    const s0 = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
    expect(s0.current?.insertingId).toBe('x');
    expect(s0.current?.probe).toBe(2);
    // Reorder swaps positions [3,4] (d ↔ e). The frame's bounds
    // [0,4] still reference indices, so it gets cancelled and
    // restarted fresh.
    const s1 = reorderInSorted(s0, 3, 1);
    expect(s1.sorted).toEqual(['a', 'b', 'c', 'e', 'd']);
    expect(s1.current?.insertingId).toBe('x');
    // Restarted from scratch → full range, probe back at midpoint.
    expect(s1.current?.lo).toBe(0);
    expect(s1.current?.hi).toBe(4);
    expect(s1.current?.probe).toBe(2);
    // X is no longer in pending — drained back onto current.
    expect(s1.pending).toEqual([]);
  });

  it('snapshot/restore round-trips a reorder + restart cleanly', () => {
    const s0 = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
    const snap = snapshotProgress(s0);
    const s1 = reorderInSorted(s0, 1, 1);
    expect(s1.sorted).toEqual(['a', 'c', 'b', 'd', 'e']);
    const restored = restoreProgress(s1, snap);
    expect(restored.sorted).toEqual(s0.sorted);
    expect(restored.current).toEqual(s0.current);
  });
});

describe('returnToPending (Phase 1 freeze-relax)', () => {
  it('moves a sorted id back to pending and installs its frame', () => {
    const s0 = seedAsSorted([A, B, C, D, E]);
    expect(s0.sorted).toEqual(['a', 'b', 'c', 'd', 'e']);
    const s1 = returnToPending(s0, 'c');
    expect(s1.sorted).toEqual(['a', 'b', 'd', 'e']);
    // c becomes the next insert; pop-on-install → current.insertingId = 'c'.
    expect(s1.current?.insertingId).toBe('c');
    expect(s1.pending).toEqual([]);
    expect(s1.done).toBe(false);
  });

  it('puts the returned id IN FRONT of any in-flight id (returned id inserts first)', () => {
    // sorted=[A..E], pending=[X] → current frame for X.
    const s0 = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
    expect(s0.current?.insertingId).toBe('x');

    // Return C from sorted. Expected: C jumps to the front, X behind it.
    const s1 = returnToPending(s0, 'c');
    expect(s1.sorted).toEqual(['a', 'b', 'd', 'e']);
    expect(s1.current?.insertingId).toBe('c'); // c is next
    expect(s1.pending).toEqual(['x']); // x bumped to pending
  });

  it('no-op when the id is not in sorted', () => {
    const s0 = seedAsSorted([A, B]);
    expect(returnToPending(s0, 'zzz')).toBe(s0);
  });

  it('flips done back to false when returning an item from a completed state', () => {
    const s0 = seedAsSorted([A, B, C]);
    expect(s0.done).toBe(true);
    const s1 = returnToPending(s0, 'b');
    expect(s1.done).toBe(false);
    expect(s1.current?.insertingId).toBe('b');
  });

  it('snapshot/restore round-trips a return-to-pending', () => {
    const s0 = seedAsSorted([A, B, C, D]);
    const snap = snapshotProgress(s0);
    const s1 = returnToPending(s0, 'b');
    expect(s1.sorted).toEqual(['a', 'c', 'd']);
    const restored = restoreProgress(s1, snap);
    expect(restored.sorted).toEqual(s0.sorted);
    expect(restored.current).toEqual(s0.current);
    expect(restored.done).toBe(true);
  });

  it('runs end-to-end via oracle: reorder + return produce the correct final ranking', () => {
    // Start with [A,B,C,D] frozen but B was actually below C in user's
    // mind. They use reorderInSorted to swap B and C; ranking is now
    // [A,C,B,D]. Then they realize D belongs above B too, so they
    // returnToPending(D) and re-insert via oracle [A,D,C,B].
    let s: InsertionState = seedAsSorted([A, B, C, D]);
    s = reorderInSorted(s, 1, 1); // a,c,b,d
    expect(s.sorted).toEqual(['a', 'c', 'b', 'd']);
    s = returnToPending(s, 'd');
    expect(s.current?.insertingId).toBe('d');
    // Drive with oracle: A < D < C < B.
    const desired = ['a', 'd', 'c', 'b'];
    const rank = new Map(desired.map((id, i) => [id, i]));
    let safety = 20;
    while (!s.done && safety-- > 0) {
      const p = getPair(s);
      if (!p) break;
      const lr = rank.get(p.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rr = rank.get(p.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = lr <= rr ? pickLeft(s) : pickRight(s);
    }
    expect(s.done).toBe(true);
    expect(getRanking(s)).toEqual(desired);
  });
});

describe('save / load roundtrip', () => {
  it('snapshot then restore preserves an in-flight insertion state', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X, Y] });
    const s1 = pickLeft(s0); // hi = probe - 1
    const snap = snapshotProgress(s1);
    const restored = restoreProgress(s1, snap);
    expect(restored.sorted).toEqual(s1.sorted);
    expect(restored.pending).toEqual(s1.pending);
    expect(restored.current).toEqual(s1.current);
    expect(restored.comparisons).toBe(s1.comparisons);
  });
});

describe('getPeekRightIds', () => {
  it('returns rank-adjacent visible ids in (probe, hi]', () => {
    // sorted=[A..E], pending=[X] → frame: probe=2 (C), hi=4. The peek
    // is the user-facing "between" preview: items D and E sit
    // immediately after the current right card C in rank order.
    const s = build({ sorted: [A, B, C, D, E], pending: [X] });
    expect(s.current?.probe).toBe(2);
    expect(s.current?.hi).toBe(4);
    expect(getPeekRightIds(s)).toEqual(['d', 'e']);
  });

  it('caps at n when the active range has more candidates', () => {
    // Larger sorted so the (probe, hi] window has 4+ candidates;
    // verify the n parameter actually trims output.
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s = build({
      sorted: [A, B, C, D, E, F, G, H],
      pending: [X],
    });
    // probe = floor(7/2) = 3 (D), hi = 7. Window (3, 7] = [E,F,G,H].
    expect(getPeekRightIds(s, 3)).toEqual(['e', 'f', 'g']);
    expect(getPeekRightIds(s, 1)).toEqual(['e']);
    expect(getPeekRightIds(s, 10)).toEqual(['e', 'f', 'g', 'h']);
  });

  it('respects hi after a pickLeft narrows the active range', () => {
    // pickLeft means inserting < probe, so hi collapses to probe-1.
    // The peek must NOT keep showing items past the new hi.
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    const s1 = pickLeft(s0); // X < C → hi = 1, new probe = 0 (A)
    expect(s1.current?.probe).toBe(0);
    expect(s1.current?.hi).toBe(1);
    expect(getPeekRightIds(s1)).toEqual(['b']);
  });

  it('skips hidden ids inside the (probe, hi] window', () => {
    // Hide D — peek should be just [E], not [D, E].
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X] });
    const s1 = hideItem(s0, 'd');
    expect(getPeekRightIds(s1)).toEqual(['e']);
  });

  it('returns [] when there is no current frame (done state)', () => {
    expect(getPeekRightIds(seedAsSorted([A, B, C]))).toEqual([]);
    expect(getPeekRightIds(seedAsSorted([]))).toEqual([]);
  });

  it('returns [] when every probe in the active range is hidden', () => {
    // Construct a case where the live frame has lo<=hi but every
    // candidate in [lo, hi] is hidden — skipHiddenProbes signals
    // "done" and the helper bails out cleanly. We do this by hiding
    // sorted items in an order that doesn't trigger the auto-splice
    // path: sorted=[A,B,C], hide A then B; the still-visible C would
    // normally get probed first. Hide C → triggers splice and clears
    // the frame. Verify [] either way.
    const s0 = build({ sorted: [A, B, C], pending: [X] });
    let s = hideItem(s0, 'a');
    s = hideItem(s, 'b');
    s = hideItem(s, 'c');
    // Frame collapsed → current should be null. Peek is [].
    expect(s.current).toBeNull();
    expect(getPeekRightIds(s)).toEqual([]);
  });
});

describe('dismissHidden / restoreHiddenItem / forgetHiddenItem', () => {
  it('dismissHidden removes a ghost id from hidden without touching ranking', () => {
    const s0: InsertionState = {
      engine: 'insertion',
      items: { a: A, b: B },
      sorted: ['a', 'b'],
      pending: [],
      current: null,
      comparisons: 0,
      done: true,
      hidden: ['ghost-id', 'a'],
      totalComparisonsEverNeeded: 0,
    };
    const s1 = dismissHidden(s0, 'ghost-id');
    expect(s1.hidden).toEqual(['a']);
    expect(s1.sorted).toEqual(['a', 'b']);
    expect(s1.done).toBe(true);
  });

  it('restoreHiddenItem re-queues an orphan hidden pending item', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [X, Y] });
    const hidden = hideItem(s0, 'y');
    expect(hidden.hidden).toContain('y');
    expect(hidden.pending).not.toContain('y');
    const restored = restoreHiddenItem(hidden, 'y');
    expect(restored.hidden).not.toContain('y');
    expect(restored.pending[0]).toBe('y');
    expect(restored.done).toBe(false);
  });

  it('restoreHiddenItem on ghost without metadata dismisses instead', () => {
    const s0: InsertionState = {
      engine: 'insertion',
      items: { a: A },
      sorted: ['a'],
      pending: [],
      current: null,
      comparisons: 0,
      done: true,
      hidden: ['ghost-id'],
      totalComparisonsEverNeeded: 0,
    };
    const s1 = restoreHiddenItem(s0, 'ghost-id');
    expect(s1.hidden).toEqual([]);
  });

  it('forgetHiddenItem removes a hidden id from sorted and hidden', () => {
    const s0 = build({ sorted: [A, B, C, D, E], pending: [] });
    const s1 = hideItem(s0, 'c');
    expect(s1.hidden).toContain('c');
    expect(s1.sorted).toContain('c');
    const s2 = forgetHiddenItem(s1, 'c');
    expect(s2.hidden).not.toContain('c');
    expect(s2.sorted).not.toContain('c');
    expect(s2.items.c).toBeDefined();
  });
});

describe('getPeekLeftIds (insertion engine)', () => {
  it('always returns [] regardless of frame state', () => {
    // The insertion engine has a single inserting id on the left
    // (no rank-adjacent neighbour), so the left peek is meaningless.
    // CompareScreen reads [] as the signal to skip rendering a left
    // peek deck entirely in insert modes.
    expect(getPeekLeftIds(build({ sorted: [A, B, C], pending: [X] }))).toEqual([]);
    expect(getPeekLeftIds(seedAsSorted([A, B, C]))).toEqual([]);
    expect(getPeekLeftIds(seedAsSorted([]))).toEqual([]);
  });
});
