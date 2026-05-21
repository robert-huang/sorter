import { describe, expect, it } from 'vitest';
import {
  addItem,
  addItems,
  appendPreRankedSublist,
  breakApartSublist,
  cancelManualInsert,
  comparisonsRemaining,
  forgetItem,
  getPair,
  getPeekLeftIds,
  getPeekRightIds,
  getRanking,
  hideItem,
  initSort,
  manualInsert,
  mergesRemaining,
  pickLeft,
  pickRight,
  reorderInSublist,
  restoreProgress,
  seedFromSublists,
  shouldAutoInsert,
  snapshotProgress,
  unhideItem,
} from '../queueMergeSort';
import type { Item, MergeState } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };

/**
 * Convenience: drive a sort by always picking the side whose head id has the
 * lower position in `desiredOrder`. Returns the final state.
 */
function runWithOracle(
  items: Item[],
  desiredOrder: string[],
): MergeState {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initSort(items);
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

describe('initSort', () => {
  it('produces N singletons and a first merge frame', () => {
    const s = initSort([A, B, C]);
    expect(s.queue.length).toBeGreaterThan(0);
    expect(s.current).not.toBeNull();
    expect(getPair(s)).toEqual({ leftId: 'a', rightId: 'b' });
    expect(s.done).toBe(false);
    expect(s.comparisons).toBe(0);
  });

  it('with 0 items is done immediately', () => {
    const s = initSort([]);
    expect(s.done).toBe(true);
    expect(s.current).toBeNull();
  });

  it('with 1 item is done immediately', () => {
    const s = initSort([A]);
    expect(s.done).toBe(true);
    expect(s.current).toBeNull();
    expect(getRanking(s)).toEqual(['a']);
  });
});

describe('mergesRemaining', () => {
  it('is N-1 for N items at start', () => {
    expect(mergesRemaining(initSort([A, B, C, D, E]))).toBe(4);
  });
  it('is 0 when done', () => {
    expect(mergesRemaining(initSort([A]))).toBe(0);
  });
  it('decreases monotonically through a sort', () => {
    let s = initSort([A, B, C, D]);
    const seen: number[] = [mergesRemaining(s)];
    let safety = 100;
    while (!s.done && safety-- > 0) {
      s = pickLeft(s); // always favour left; doesn't matter for the invariant
      seen.push(mergesRemaining(s));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
    expect(mergesRemaining(s)).toBe(0);
  });
});

describe('comparisonsRemaining', () => {
  it('N=3 starts at 3 and counts down 3 → 2 → 1 → 0 on an alphabetic-oracle trace', () => {
    // initSort([A,B,C]) → queue [[a],[b],[c]] → current frame ([a] vs [b]).
    // Worst-case schedule: ([a] vs [b]) = 1, then result-of-that (size 2) vs
    // [c] = 2 → total 3.
    let s = initSort([A, B, C]);
    expect(comparisonsRemaining(s)).toBe(3);
    const seen: number[] = [comparisonsRemaining(s)];
    let safety = 50;
    while (!s.done && safety-- > 0) {
      const pair = getPair(s);
      if (!pair) break;
      // alphabetic oracle: prefer the lexicographically-smaller side
      s = pair.leftId <= pair.rightId ? pickLeft(s) : pickRight(s);
      seen.push(comparisonsRemaining(s));
    }
    // Strict monotone descent on this trace (no auto-completes).
    expect(seen).toEqual([3, 2, 1, 0]);
    expect(s.done).toBe(true);
  });

  it('N=4 worst case is 5 (= 1 + 1 + 3)', () => {
    // queue: [[a],[b],[c],[d]]; current = ([a] vs [b]).
    // Forecast: ([a]v[b])=1 → size 2, ([c]v[d])=1 → size 2, (2 v 2) = 3.
    expect(comparisonsRemaining(initSort([A, B, C, D]))).toBe(5);
  });

  it('N=4 can finish in 4 with one auto-completed merge, bar jumps 2 → 0', () => {
    // After both intra-pair merges, suppose the second merged sublist
    // (cd order: c,d) compares first against a (head of merged [a,b]):
    // pick a; next pair is b vs c; pick b → b smaller. Then current frame
    // exhausts left → flush appends c, d as remainder. That last merge cost
    // only 2 comparisons instead of the worst-case 3. Total: 4 comparisons.
    const desired = ['a', 'b', 'c', 'd'];
    const rank = new Map(desired.map((id, i) => [id, i]));
    let s = initSort([A, B, C, D]);
    let prevRemaining = comparisonsRemaining(s);
    let jumpSeen = false;
    let safety = 50;
    while (!s.done && safety-- > 0) {
      const pair = getPair(s);
      if (!pair) break;
      const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = lr <= rr ? pickLeft(s) : pickRight(s);
      const cur = comparisonsRemaining(s);
      // Track whether a single step ever dropped `remaining` by more than 1
      // — that's the visible "jump forward" caused by an auto-complete.
      if (prevRemaining - cur > 1) jumpSeen = true;
      prevRemaining = cur;
    }
    expect(s.done).toBe(true);
    expect(s.comparisons).toBe(4);
    expect(jumpSeen).toBe(true);
    expect(getRanking(s)).toEqual(desired);
  });

  it("hidden items don't contribute to either side's size", () => {
    // Without hiding, N=4 worst case = 5. Hide one item → effectively N=3,
    // so worst case becomes 3.
    let s = initSort([A, B, C, D]);
    s = hideItem(s, 'd');
    expect(comparisonsRemaining(s)).toBe(3);
  });

  it('all-hidden sublists contribute 0', () => {
    let s = initSort([A, B]);
    s = hideItem(s, 'a');
    s = hideItem(s, 'b');
    // Both hidden → flushes through to done; nothing left to compare.
    expect(comparisonsRemaining(s)).toBe(0);
  });

  it('is 0 when done', () => {
    expect(comparisonsRemaining(initSort([A]))).toBe(0);
  });
});

describe('pickLeft / pickRight produce a correct final ranking', () => {
  it('reverse alphabetical: D, C, B, A', () => {
    const desired = ['d', 'c', 'b', 'a'];
    const s = runWithOracle([A, B, C, D], desired);
    expect(s.done).toBe(true);
    expect(getRanking(s)).toEqual(desired);
  });

  it('forward alphabetical: A, B, C, D, E', () => {
    const desired = ['a', 'b', 'c', 'd', 'e'];
    const s = runWithOracle([A, B, C, D, E], desired);
    expect(getRanking(s)).toEqual(desired);
  });

  it('arbitrary order: C, A, E, B, D', () => {
    const desired = ['c', 'a', 'e', 'b', 'd'];
    const s = runWithOracle([A, B, C, D, E], desired);
    expect(getRanking(s)).toEqual(desired);
  });

  it('comparisons grow by 1 each pick', () => {
    let s = initSort([A, B, C]);
    expect(s.comparisons).toBe(0);
    s = pickLeft(s);
    expect(s.comparisons).toBe(1);
  });
});

describe('hideItem', () => {
  it('removes item from final ranking', () => {
    let s = initSort([A, B, C]);
    s = hideItem(s, 'b');
    // Drive with an alphabetic oracle so the expected order is deterministic.
    while (!s.done) {
      const pair = getPair(s);
      if (!pair) break;
      s = pair.leftId <= pair.rightId ? pickLeft(s) : pickRight(s);
    }
    expect(getRanking(s)).toEqual(['a', 'c']);
  });

  it('auto-completes merge when one side empties of visible items', () => {
    let s = initSort([A, B]);
    expect(getPair(s)).toEqual({ leftId: 'a', rightId: 'b' });
    s = hideItem(s, 'a');
    expect(s.done).toBe(true);
    expect(getRanking(s)).toEqual(['b']);
  });

  it('is reversible via undo (snapshot)', () => {
    const s0 = initSort([A, B, C]);
    const snap = snapshotProgress(s0);
    const s1 = hideItem(s0, 'b');
    expect(s1.hidden).toContain('b');
    const restored = restoreProgress(s1, snap);
    expect(restored.hidden).toEqual([]);
  });

  it('is idempotent', () => {
    const s0 = initSort([A, B, C]);
    const s1 = hideItem(s0, 'b');
    const s2 = hideItem(s1, 'b');
    expect(s2.hidden).toEqual(['b']);
  });

  it('hiding both items of the only pair completes the sort', () => {
    let s = initSort([A, B]);
    s = hideItem(s, 'a');
    s = hideItem(s, 'b');
    expect(s.done).toBe(true);
    expect(getRanking(s)).toEqual([]);
  });
});

describe('unhideItem', () => {
  it('restores a hidden item back into the structure', () => {
    let s = initSort([A, B, C]);
    s = hideItem(s, 'b');
    s = unhideItem(s, 'b');
    expect(s.hidden).toEqual([]);
  });
  it('is a no-op for items that are not hidden', () => {
    let s = initSort([A, B, C]);
    s = unhideItem(s, 'b');
    expect(s.hidden).toEqual([]);
  });
});

describe('addItem (mid-sort)', () => {
  it('adds a new singleton to the back of the queue', () => {
    const s0 = initSort([A, B]);
    const s1 = addItem(s0, C)!;
    expect(s1.items.c).toEqual(C);
    expect(s1.queue.some((sub) => sub.includes('c'))).toBe(true);
  });

  it('refuses duplicates by canonical id', () => {
    const s0 = initSort([A]);
    expect(addItem(s0, A)).toBeNull();
  });

  it('flips done back to false and a merge resumes', () => {
    let s = initSort([A]);
    expect(s.done).toBe(true);
    s = addItem(s, B)!;
    expect(s.done).toBe(false);
    expect(getPair(s)).toEqual({ leftId: 'a', rightId: 'b' });
  });
});

describe('addItems (batch singletons)', () => {
  it('appends N items as N singleton sublists, preserving input order', () => {
    const s0 = initSort([A, B]);
    expect(s0.queue.length).toBeGreaterThanOrEqual(0);
    const beforeQ = s0.queue.length;
    const { state: s1, skipped } = addItems(s0, [C, D, E]);
    expect(skipped).toEqual([]);
    // Three new singletons at the back, in C/D/E order.
    expect(s1.queue.slice(beforeQ)).toEqual([['c'], ['d'], ['e']]);
    expect(s1.items.c).toBeDefined();
    expect(s1.items.d).toBeDefined();
    expect(s1.items.e).toBeDefined();
  });

  it('flips done back to false when adding into a completed sort', () => {
    // Drive a 2-item sort to done, then bulk-add.
    let s: MergeState = initSort([A, B]);
    while (!s.done) {
      const p = getPair(s);
      if (!p) break;
      s = p.leftId <= p.rightId ? pickLeft(s) : pickRight(s);
    }
    expect(s.done).toBe(true);
    const { state: next } = addItems(s, [C, D]);
    expect(next.done).toBe(false);
    // After advance(), one of C/D should be in flight via current.
    expect(next.current || next.queue.some((sub) => sub.length > 0)).toBeTruthy();
  });

  it('dedups by id and reports skipped; metadata fills missing fields only', () => {
    const s0 = initSort([{ id: 'a', label: 'A' }, B]);
    const { state: s1, skipped } = addItems(s0, [
      { id: 'a', label: 'A', url: 'https://new', imageUrl: 'https://i' },
      C,
    ]);
    expect(skipped).toEqual(['a']);
    expect(s1.items.a.url).toBe('https://new');
    expect(s1.items.a.imageUrl).toBe('https://i');
    // C added as a singleton.
    expect(s1.queue.some((sub) => sub.length === 1 && sub[0] === 'c')).toBe(true);
  });

  it("does not overwrite the existing item's URL when both are set", () => {
    const s0 = initSort([{ id: 'a', label: 'A', url: 'https://orig' }]);
    const { state: s1, skipped } = addItems(s0, [
      { id: 'a', label: 'A', url: 'https://new' },
    ]);
    expect(skipped).toEqual(['a']);
    expect(s1.items.a.url).toBe('https://orig');
  });

  it('all-duplicate input returns the same state with skipped populated', () => {
    const s0 = initSort([A, B]);
    const beforeQ = s0.queue.map((sub) => sub.slice());
    const { state: s1, skipped } = addItems(s0, [A, B]);
    expect(skipped).toEqual(['a', 'b']);
    // Queue unchanged when there are no survivors.
    expect(s1.queue).toEqual(beforeQ);
  });

  it('bumps totalComparisonsEverNeeded — bar never moves backwards', () => {
    const s0 = initSort([A, B]);
    const before = s0.totalComparisonsEverNeeded;
    const { state: s1 } = addItems(s0, [C, D, E]);
    expect(s1.totalComparisonsEverNeeded).toBeGreaterThanOrEqual(before);
  });

  it('produces the same final ranking as calling addItem in a loop', () => {
    // Run two parallel sorts: one via N addItem calls, one via addItems(N),
    // both driven by the same alphabetic oracle. Final ranks must agree.
    const seedA: MergeState = initSort([A]);
    const seedB: MergeState = initSort([A]);
    const adds = [B, C, D, E];

    let loopState: MergeState = seedA;
    for (const it of adds) {
      const r = addItem(loopState, it);
      if (r) loopState = r;
    }
    while (!loopState.done) {
      const p = getPair(loopState);
      if (!p) break;
      loopState = p.leftId <= p.rightId ? pickLeft(loopState) : pickRight(loopState);
    }

    let batchState: MergeState = addItems(seedB, adds).state;
    while (!batchState.done) {
      const p = getPair(batchState);
      if (!p) break;
      batchState = p.leftId <= p.rightId ? pickLeft(batchState) : pickRight(batchState);
    }

    expect(getRanking(loopState)).toEqual(getRanking(batchState));
  });
});

describe('appendPreRankedSublist', () => {
  it('adds the sublist to the back and net-new items only', () => {
    const s0 = initSort([A, B]);
    const { state: s1, skipped } = appendPreRankedSublist(s0, [B, C, D]);
    expect(skipped).toEqual(['b']);
    expect(s1.items.c).toBeDefined();
    expect(s1.items.d).toBeDefined();
    const back = s1.queue[s1.queue.length - 1];
    expect(back).toEqual(['c', 'd']);
  });

  it('fills in missing URL/IMAGE from later metadata', () => {
    const s0 = initSort([{ id: 'a', label: 'A' }]);
    const { state: s1 } = appendPreRankedSublist(s0, [
      { id: 'a', label: 'A', url: 'https://x', imageUrl: 'https://i' },
    ]);
    expect(s1.items.a.url).toBe('https://x');
    expect(s1.items.a.imageUrl).toBe('https://i');
  });

  it('does not overwrite existing metadata', () => {
    const s0 = initSort([{ id: 'a', label: 'A', url: 'https://orig' }]);
    const { state: s1 } = appendPreRankedSublist(s0, [
      { id: 'a', label: 'A', url: 'https://new' },
    ]);
    expect(s1.items.a.url).toBe('https://orig');
  });
});

describe('reorderInSublist', () => {
  it('swaps adjacent items', () => {
    // After hiding nothing and merging [a,b] and [c,d] we get one sublist
    // [a,b,c,d] in the queue. Let's construct via seedFromSublists for clarity.
    const s0 = seedFromSublists({
      sublists: [[A, B, C, D]],
      extras: [],
    });
    const s1 = reorderInSublist(s0, 0, 1, 1); // swap b and c
    expect(s1.queue[0]).toEqual(['a', 'c', 'b', 'd']);
  });

  it('rejects out-of-range indices', () => {
    const s0 = seedFromSublists({ sublists: [[A, B]], extras: [] });
    const s1 = reorderInSublist(s0, 0, 0, -1); // can't move the head up
    expect(s1.queue[0]).toEqual(['a', 'b']);
  });
});

describe('breakApartSublist', () => {
  it('explodes a queued multi-item sublist into singletons at the end', () => {
    // Append a 3-item pre-ranked sublist so it sits in the queue. The first
    // merge between [A] and [B] is still in flight in `current`, so
    // queue[0] is the appended [c,d,e].
    const s0 = initSort([A, B]);
    expect(s0.current).not.toBeNull();
    const { state: s1 } = appendPreRankedSublist(s0, [C, D, E]);
    expect(s1.queue).toEqual([['c', 'd', 'e']]);

    const s2 = breakApartSublist(s1, 0);
    // Splice removes [c,d,e], then each id pushed as its own singleton.
    expect(s2.queue).toEqual([['c'], ['d'], ['e']]);
  });

  it('is a no-op for single-item sublists', () => {
    const s0 = initSort([A, B]);
    const { state: s1 } = appendPreRankedSublist(s0, [C]);
    expect(s1.queue).toEqual([['c']]);
    const s2 = breakApartSublist(s1, 0);
    expect(s2.queue).toEqual(s1.queue);
  });

  it('rejects out-of-range indices', () => {
    const s0 = initSort([A, B]);
    expect(breakApartSublist(s0, 5)).toBe(s0);
    expect(breakApartSublist(s0, -1)).toBe(s0);
  });
});

describe('advance: degenerate-frame skipping', () => {
  it('a fully-hidden singleton in queue does not stall', () => {
    let s = initSort([A, B, C]);
    s = hideItem(s, 'c');
    while (!s.done) s = pickLeft(s);
    expect(getRanking(s)).toEqual(['a', 'b']);
  });
});

describe('seedFromSublists', () => {
  it('extras precede pre-ranked sublists in the queue', () => {
    const s = seedFromSublists({
      sublists: [[A, B]],
      extras: [C, D],
    });
    // Initial queue is [[c],[d],[a,b]]. Current pops first two => [[a,b]] in queue.
    expect(s.items.c).toBeDefined();
    expect(s.items.a).toBeDefined();
    // Check that a pre-ranked sublist is somewhere (either in queue or about to be).
    const everywhere = [
      ...s.queue,
      s.current ? s.current.left : [],
      s.current ? s.current.right : [],
    ];
    const hasAB = everywhere.some(
      (sub) => sub.length === 2 && sub[0] === 'a' && sub[1] === 'b',
    );
    expect(hasAB).toBe(true);
  });

  it('preserves the user-expressed order in the pre-ranked sublist', () => {
    // If user provides a pre-ranked list [B, A] and an extra C, and always
    // picks the front of the pre-ranked list when comparing across sublists,
    // B should rank above A.
    const s0 = seedFromSublists({
      sublists: [[B, A]],
      extras: [C],
    });
    // Drive the sort by always preferring whichever side already had higher
    // priority in the pre-ranked list (B before A; C neutral).
    const desired = ['b', 'a', 'c'];
    const rank = new Map(desired.map((id, i) => [id, i]));
    let s = s0;
    let safety = 100;
    while (!s.done && safety-- > 0) {
      const pair = getPair(s);
      if (!pair) break;
      const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = lr <= rr ? pickLeft(s) : pickRight(s);
    }
    expect(getRanking(s)).toEqual(desired);
  });
});

describe('snapshot/restore round-trip', () => {
  it('a pick can be undone exactly', () => {
    const s0 = initSort([A, B, C, D]);
    const snap = snapshotProgress(s0);
    const s1 = pickLeft(s0);
    const restored = restoreProgress(s1, snap);
    expect(restored.queue).toEqual(s0.queue);
    expect(restored.current).toEqual(s0.current);
    expect(restored.comparisons).toBe(0);
    expect(restored.done).toBe(false);
  });

  it('a hide can be undone exactly', () => {
    const s0 = initSort([A, B, C]);
    const snap = snapshotProgress(s0);
    const s1 = hideItem(s0, 'a');
    const restored = restoreProgress(s1, snap);
    expect(restored.hidden).toEqual([]);
    expect(getPair(restored)).toEqual(getPair(s0));
  });
});

// ============================================================================
// Exile on merge close (new) — when a merge closes with items hidden, the
// hidden ids land in `state.toBeInserted` instead of riding along inside the
// closed sublist. See plan §5b.
// ============================================================================

/**
 * Drive a merge state by oracle until done OR until the predicate
 * returns true. Returns the final state and the count of comparisons made.
 *
 * The third arg can be EITHER a stopWhen predicate (back-compat) OR a
 * MergeOptions bag — `runUntil(s, order, { autoInsertEnabled: false })`.
 * Some callers need both, so the fourth slot accepts the options bag
 * when the third is a predicate.
 */
function runUntil(
  initial: MergeState,
  desiredOrder: string[],
  stopWhenOrOpts?: ((s: MergeState) => boolean) | { autoInsertEnabled?: boolean },
  maybeOpts?: { autoInsertEnabled?: boolean },
): MergeState {
  const stopWhen = typeof stopWhenOrOpts === 'function' ? stopWhenOrOpts : undefined;
  const opts =
    typeof stopWhenOrOpts === 'object' && stopWhenOrOpts !== null
      ? stopWhenOrOpts
      : maybeOpts;
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let safety = 1000;
  while (!s.done && safety-- > 0) {
    if (stopWhen && stopWhen(s)) return s;
    const pair = getPair(s);
    if (!pair) break;
    const lr = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rr = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = lr <= rr ? pickLeft(s, opts) : pickRight(s, opts);
  }
  return s;
}

describe('exile on merge close (plan §5b)', () => {
  it('hidden mid-merge ids land in `toBeInserted`, not in the closed sublist', () => {
    // Construct the chat-time example via seedFromSublists so we have
    // a deterministic initial merge of [A,B,C,D,E] vs [F,G,H].
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    expect(s0.current).not.toBeNull();
    expect(s0.current!.left).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s0.current!.right).toEqual(['f', 'g', 'h']);

    // Hide G before any picks land on it.
    let s = hideItem(s0, 'g');
    // Drive: ABC over F, F over D (so F goes in merged after a/b/c),
    // D, E land. Order in `merged` ends up [a,b,c,f,d,e]; right side
    // tail is [h] (g is hidden). Closing: visible = [a,b,c,f,d,e,h],
    // exiled = [g] → queue gets [a,b,c,f,d,e,h]; toBeInserted=['g'].
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual(['g']);
    expect(s.queue).toEqual([['a', 'b', 'c', 'f', 'd', 'e', 'h']]);
  });

  it('unhide while still in current.left / current.right rejoins the merge', () => {
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    // Hide G, then unhide G before the merge reaches it. Then run to
    // completion: G should appear in the final ranking, no toBeInserted.
    let s = hideItem(s0, 'g');
    s = unhideItem(s, 'g');
    s = runUntil(s, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual([]);
    expect(getRanking(s)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('undo across exile restores the pre-close snapshot (hidden, toBeInserted empty)', () => {
    // 5-vs-3 merge so hiding one right-side item doesn't auto-close.
    // Snapshot mid-merge (G hidden, no exile yet), drive to close
    // (exile happens), restore — should be back to mid-merge / no exile.
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    let s = hideItem(s0, 'g');
    expect(s.toBeInserted).toEqual([]);
    expect(s.current).not.toBeNull();
    const snap = snapshotProgress(s);

    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.toBeInserted).toEqual(['g']);
    expect(s.done).toBe(true);

    const restored = restoreProgress(s, snap);
    expect(restored.toBeInserted).toEqual([]);
    expect(restored.hidden).toContain('g');
    expect(restored.done).toBe(false);
    expect(restored.current).not.toBeNull();
  });

  it('done is gated by pending manual inserts (not by toBeInserted)', () => {
    // After exile, queue has one sublist and current is null; the
    // sort IS done — toBeInserted does NOT block done. The user chose
    // (by hiding) to leave those items out.
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    let s = hideItem(s0, 'g');
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual(['g']);

    // But if we click Insert on G, done flips back to false until G
    // resolves.
    const sInserting = manualInsert(s, 'g');
    expect(sInserting.done).toBe(false);
    expect(sInserting.currentManualInsert?.insertingId).toBe('g');
  });
});

describe('manualInsert + drainManualInserts (plan §5c)', () => {
  it('Insert on G after exile binary-searches G into the closed sublist', () => {
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    let s = hideItem(s0, 'g');
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.toBeInserted).toEqual(['g']);

    // Click Insert on G; manual-insert frame should appear with G against
    // some probe from the [a,b,c,f,d,e,h] sublist.
    s = manualInsert(s, 'g');
    expect(s.currentManualInsert).not.toBeNull();
    expect(s.currentManualInsert!.insertingId).toBe('g');
    expect(getPair(s)?.leftId).toBe('g');

    // Resolve with oracle: G ranks between F and H.
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual([]);
    expect(s.currentManualInsert).toBeNull();
    // G is somewhere between F (index 3) and H (last) in the final
    // sublist, depending on probe order. With MVP full-range bounds,
    // exact position depends on the oracle path.
    const final = s.queue[0];
    const gi = final.indexOf('g');
    const fi = final.indexOf('f');
    const hi = final.indexOf('h');
    expect(gi).toBeGreaterThan(fi);
    expect(gi).toBeLessThan(hi);
  });

  it('Insert mid-merge queues until the merge closes (deferred drain)', () => {
    // Set up: merge [A,B,C] vs [D]; hide B; pick to close merge.
    // Force the classic merge path because auto-insert would intercept
    // this shape (K=1, N=3 → binary insert beats the full merge) and
    // turn this into an auto-insert scenario, which has its own tests.
    const s0 = seedFromSublists(
      {
        sublists: [[A, B, C], [D]],
        extras: [],
      },
      { autoInsertEnabled: false },
    );
    let s = hideItem(s0, 'b', { autoInsertEnabled: false });
    // Pick A → A goes to merged. Now left=[B,C] (visibly [C]).
    // Pick C over D → C to merged; left=[]. flushIfMergeComplete →
    // visible=[A,C,D], exile=[B]. Done.
    s = runUntil(s, ['a', 'c', 'b', 'd'], { autoInsertEnabled: false });
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual(['b']);
    expect(s.queue).toEqual([['a', 'c', 'd']]);
  });

  it('drainManualInserts installs the manual-insert frame immediately when no merge is running', () => {
    // s.done with toBeInserted=['x']; insert X → frame installed at once.
    const X: Item = { id: 'x', label: 'X' };
    const s0 = initSort([A, B, X]);
    // Hide X mid-merge, then drive to close. X gets exiled.
    let s = hideItem(s0, 'x');
    s = runUntil(s, ['a', 'b', 'x']);
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toEqual(['x']);
    expect(s.currentManualInsert).toBeNull();

    s = manualInsert(s, 'x');
    expect(s.currentManualInsert).not.toBeNull();
    expect(s.currentManualInsert!.insertingId).toBe('x');
  });

  it('forgetItem drops the id permanently', () => {
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    let s = hideItem(s0, 'g');
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    expect(s.toBeInserted).toEqual(['g']);
    s = forgetItem(s, 'g');
    expect(s.toBeInserted).toEqual([]);
    expect(getRanking(s)).not.toContain('g');
  });

  it('cancelManualInsert bounces the inserting id back to toBeInserted', () => {
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    const s0 = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    let s = hideItem(s0, 'g');
    s = runUntil(s, ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h']);
    s = manualInsert(s, 'g');
    expect(s.currentManualInsert?.insertingId).toBe('g');
    s = cancelManualInsert(s);
    expect(s.currentManualInsert).toBeNull();
    expect(s.toBeInserted).toContain('g');
  });
});

// ============================================================================
// Phase 2: auto-insert heuristic
//
// advance() may swap a popped queue pair for binary insertion when the
// smaller side is small enough that insertion beats the full merge. The
// frame lives on `currentAutoInsert`; rank-aware bound tightening makes
// subsequent inserts cheaper than the rank-blind worst case.
// ============================================================================

describe('shouldAutoInsert heuristic', () => {
  it('returns true when binary insertion strictly beats the merge', () => {
    // Concrete cases from the heuristic doc comment.
    expect(shouldAutoInsert(1, 4)).toBe(true); // 1*⌈log₂5⌉=3 < 4
    expect(shouldAutoInsert(4, 1)).toBe(true); // symmetric
    expect(shouldAutoInsert(2, 8)).toBe(true); // 2·⌈log₂10⌉=8 < 9
    expect(shouldAutoInsert(1, 100)).toBe(true);
  });

  it('returns false when the merge would tie or win', () => {
    expect(shouldAutoInsert(3, 5)).toBe(false); // 3·⌈log₂8⌉=9 > 7
    expect(shouldAutoInsert(4, 4)).toBe(false); // 4·⌈log₂8⌉=12 > 7
    expect(shouldAutoInsert(1, 1)).toBe(false); // insert=1 not < merge=1
    expect(shouldAutoInsert(2, 2)).toBe(false);
  });

  it('returns false on degenerate sizes', () => {
    expect(shouldAutoInsert(0, 5)).toBe(false);
    expect(shouldAutoInsert(5, 0)).toBe(false);
    expect(shouldAutoInsert(0, 0)).toBe(false);
  });
});

describe('advance() auto-insert installation', () => {
  it('installs an auto-insert frame when the popped pair is skewed', () => {
    // [A,B,C,D,E] vs [F] — K=1, N=5. insert=⌈log₂6⌉=3 < merge=5.
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    expect(s.current).toBeNull();
    expect(s.currentAutoInsert).not.toBeNull();
    expect(s.currentAutoInsert!.target).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.currentAutoInsert!.pendingInserts).toEqual([]);
    expect(s.currentAutoInsert!.frame).not.toBeNull();
    expect(s.currentAutoInsert!.frame!.insertingId).toBe('f');
  });

  it('falls back to a normal merge when the pair is balanced', () => {
    // [A,B,C] vs [D,E,F] — K=N=3. insert=3·⌈log₂6⌉=9 > merge=5.
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[A, B, C], [D, E, F]],
      extras: [],
    });
    expect(s.currentAutoInsert).toBeNull();
    expect(s.current).not.toBeNull();
  });

  it('does NOT auto-insert when the flag is off, even for skewed pairs', () => {
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists(
      { sublists: [[A, B, C, D, E], [F]], extras: [] },
      { autoInsertEnabled: false },
    );
    expect(s.currentAutoInsert).toBeNull();
    expect(s.current).not.toBeNull();
    expect(s.current!.left).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.current!.right).toEqual(['f']);
  });

  it('picks the LARGER side as target and the SMALLER as pendingInserts', () => {
    // Reverse the input order: smaller first. Engine should still
    // put the larger side on `target`.
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[F], [A, B, C, D, E]],
      extras: [],
    });
    expect(s.currentAutoInsert!.target).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.currentAutoInsert!.frame!.insertingId).toBe('f');
  });

  it('drives a 1-into-5 auto-insert to completion (inserts F mid-list)', () => {
    // Insert F somewhere in the middle. Oracle says C < F < D.
    const F: Item = { id: 'f', label: 'F' };
    const s0 = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    // Drive: oracle ranks F between C and D.
    const s = runUntil(s0, ['a', 'b', 'c', 'f', 'd', 'e']);
    expect(s.done).toBe(true);
    expect(s.currentAutoInsert).toBeNull();
    expect(s.queue).toEqual([['a', 'b', 'c', 'f', 'd', 'e']]);
  });
});

describe('drainAutoInsert rank-aware bound tightening', () => {
  it('uses lastInsertedPosition + 1 as the next insert\'s lower bound', () => {
    // Use 2-into-8 so multiple inserts happen and rank-aware bounds
    // can compound. pendingInserts is [X, Y] in rank order; X lands,
    // then Y\'s startInsert is called with lo = X\'s position + 1.
    const items: Item[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
      (id) => ({ id, label: id.toUpperCase() }),
    );
    const X: Item = { id: 'x', label: 'X' };
    const Y: Item = { id: 'y', label: 'Y' };
    // K=2 vs N=8 → insertCost=2·⌈log₂10⌉=8 < mergeCost=9 → auto-insert.
    const s0 = seedFromSublists({
      sublists: [items, [X, Y]],
      extras: [],
    });
    expect(s0.currentAutoInsert).not.toBeNull();
    // Drive: X ranks between B and C; Y ranks between D and E.
    const oracle = ['a', 'b', 'x', 'c', 'd', 'y', 'e', 'f', 'g', 'h'];
    const s = runUntil(s0, oracle);
    expect(s.done).toBe(true);
    expect(s.queue).toEqual([oracle]);
  });

  it('exiles hidden target ids when the auto-insert closes', () => {
    // 1-into-5, hide one of the target ids mid-auto-insert. The
    // probe-skip path keeps the auto-insert running; the exile rule
    // applies at close time so the hidden id ends up in `toBeInserted`
    // instead of riding along in the closed sublist at a stale slot.
    const F: Item = { id: 'f', label: 'F' };
    const seed = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    let s = hideItem(seed, 'd');
    expect(s.hidden).toContain('d');
    // Drive: oracle says F should land between B and C.
    s = runUntil(s, ['a', 'b', 'f', 'c', 'e']);
    expect(s.done).toBe(true);
    // D should be exiled to toBeInserted (the exile rule on merge close
    // applies equally to auto-insert close).
    expect(s.toBeInserted).toContain('d');
    // D should NOT be in the final queue.
    expect(s.queue[0]).not.toContain('d');
  });

  it('cancels the in-flight auto-insert when its inserting id is hidden, then continues the next pendingInsert', () => {
    const items: Item[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
      (id) => ({ id, label: id.toUpperCase() }),
    );
    const X: Item = { id: 'x', label: 'X' };
    const Y: Item = { id: 'y', label: 'Y' };
    const s0 = seedFromSublists({
      sublists: [items, [X, Y]],
      extras: [],
    });
    // First insert is X. Hide X mid-flight; the frame should cancel
    // and the engine should advance to Y.
    expect(s0.currentAutoInsert!.frame!.insertingId).toBe('x');
    const s1 = hideItem(s0, 'x');
    // Either Y is the new in-flight insert, or pendingInserts has
    // already drained to a frame on Y.
    expect(s1.currentAutoInsert!.frame).not.toBeNull();
    expect(s1.currentAutoInsert!.frame!.insertingId).toBe('y');
    expect(s1.hidden).toContain('x');
  });

  it('drops a queued pendingInsert id when it is hidden', () => {
    const items: Item[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
      (id) => ({ id, label: id.toUpperCase() }),
    );
    const X: Item = { id: 'x', label: 'X' };
    const Y: Item = { id: 'y', label: 'Y' };
    const s0 = seedFromSublists({
      sublists: [items, [X, Y]],
      extras: [],
    });
    // Y is queued (X is in flight). Hide Y; pendingInserts loses Y.
    const s1 = hideItem(s0, 'y');
    expect(s1.currentAutoInsert!.pendingInserts).not.toContain('y');
  });
});

describe('auto-insert + snapshot/undo', () => {
  it('snapshotProgress deep-copies currentAutoInsert so mutations on the live state do not leak', () => {
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    const snap = snapshotProgress(s);
    // Mutate the live state\'s frame.
    s.currentAutoInsert!.target.push('z');
    expect(snap.currentAutoInsert).not.toBeNull();
    expect(snap.currentAutoInsert!.target).not.toContain('z');
  });

  it('restoreProgress brings back an in-flight auto-insert frame', () => {
    const F: Item = { id: 'f', label: 'F' };
    const s0 = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    const snap = snapshotProgress(s0);
    // Drive one pick — frame advances.
    const s1 = pickLeft(s0);
    expect(s1.currentAutoInsert!.frame).not.toBeNull();
    // Undo via restoreProgress puts the frame back to its install state.
    const s2 = restoreProgress(s1, snap);
    expect(s2.currentAutoInsert!.frame!.insertingId).toBe(
      s0.currentAutoInsert!.frame!.insertingId,
    );
    expect(s2.currentAutoInsert!.target).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('comparisonsRemaining auto-insert forecast', () => {
  it('charges min(merge, auto-insert) per pair when the flag is on', () => {
    const F: Item = { id: 'f', label: 'F' };
    const sOn = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    const sOff = seedFromSublists(
      { sublists: [[A, B, C, D, E], [F]], extras: [] },
      { autoInsertEnabled: false },
    );
    // The auto-insert forecast (~⌈log₂6⌉ = 3) is strictly cheaper than
    // the merge forecast (5 + 1 - 1 = 5).
    const onCost = comparisonsRemaining(sOn, { autoInsertEnabled: true });
    const offCost = comparisonsRemaining(sOff, { autoInsertEnabled: false });
    expect(onCost).toBeLessThan(offCost);
  });
});

// ============================================================================
// Peek-deck helpers
//
// `getPeekRightIds` and `getPeekLeftIds` drive the rank-adjacent preview
// cards rendered behind the live A/B comparison cards. Three modes:
//
//   - manual-insert: peek = sorted candidates after the current probe in
//     the active sublist. Left peek is empty (single inserting id, no
//     rank-adjacent neighbour).
//   - auto-insert: same as manual-insert, but driven by the auto-insert
//     frame against currentAutoInsert.target.
//   - merge: peek = next visible ids in current.left / current.right
//     after each side's head.
//
// Dispatch priority is manual > auto > merge so a hidden-item cleanup
// that happens to leave a manual-insert frame in flight doesn't fall
// through to the merge branch.
// ============================================================================

describe('getPeekRightIds (merge engine)', () => {
  it('walks current.right after the head in normal merge mode', () => {
    // K=2, N=3 — auto-insert heuristic does NOT trip (insert=6 > merge=4),
    // so the popped pair stays in classic merge mode with current set.
    const s = seedFromSublists({
      sublists: [[A, B, C], [D, E]],
      extras: [],
    });
    expect(s.currentManualInsert).toBeNull();
    expect(s.currentAutoInsert).toBeNull();
    expect(s.current).not.toBeNull();
    const pair = getPair(s);
    // The merge frame's left/right ordering is implementation-defined;
    // pick the assertion based on whichever sublist landed on the right.
    if (pair?.rightId === 'd') {
      // current.right = [d, e] → peek after head d = [e]
      expect(getPeekRightIds(s)).toEqual(['e']);
    } else if (pair?.rightId === 'a') {
      // current.right = [a, b, c] → peek after head a = [b, c]
      expect(getPeekRightIds(s)).toEqual(['b', 'c']);
    } else {
      throw new Error(`unexpected merge pair: ${JSON.stringify(pair)}`);
    }
  });

  it('caps at n and skips hidden ids on the right side', () => {
    const F: Item = { id: 'f', label: 'F' };
    const s0 = seedFromSublists({
      sublists: [[A, B, C], [D, E, F]],
      extras: [],
    });
    const pair = getPair(s0);
    // Pick the side with the longer tail so n actually trims something.
    if (pair?.rightId === 'd') {
      // current.right = [d, e, f]. Hide e — peek after d = [f].
      const s1 = hideItem(s0, 'e');
      expect(getPeekRightIds(s1, 3)).toEqual(['f']);
      // n=1 from the unmodified state still respects the cap.
      expect(getPeekRightIds(s0, 1)).toEqual(['e']);
    } else {
      const s1 = hideItem(s0, 'b');
      expect(getPeekRightIds(s1, 3)).toEqual(['c']);
      expect(getPeekRightIds(s0, 1)).toEqual(['b']);
    }
  });

  it('returns [] when there is no current merge frame', () => {
    // Singleton list: initSort is done immediately with current=null.
    expect(getPeekRightIds(initSort([A]))).toEqual([]);
    expect(getPeekRightIds(initSort([]))).toEqual([]);
  });

  it('dispatches to auto-insert frame when one is active', () => {
    // K=1, N=5 → auto-insert installs with target=[a..e], frame on f.
    // Right peek must come from the insert frame's (probe, hi] window
    // in the target sublist — NOT from current.left/right (which are
    // null in auto-insert mode).
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    expect(s.current).toBeNull();
    expect(s.currentAutoInsert).not.toBeNull();
    // Initial probe = floor(4/2) = 2 (c), hi = 4. Peek = [d, e].
    expect(s.currentAutoInsert!.frame!.probe).toBe(2);
    expect(s.currentAutoInsert!.frame!.hi).toBe(4);
    expect(getPeekRightIds(s)).toEqual(['d', 'e']);
  });

  it('dispatches to manual-insert frame, ignoring any merge state', () => {
    // Hide an item, drive the sort to done so it lands in toBeInserted,
    // then click Insert. The state now has currentManualInsert set with
    // a frame against the closed sublist; getPeekRightIds must follow
    // that frame, not any stale current.right.
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    let s: MergeState = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    s = hideItem(s, 'g', { autoInsertEnabled: false });
    // Drive to close so g exiles to toBeInserted.
    const order = ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h'];
    const rank = new Map(order.map((id, i) => [id, i]));
    let safety = 200;
    while (!s.done && safety-- > 0) {
      const p = getPair(s);
      if (!p) break;
      const lr = rank.get(p.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rr = rank.get(p.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = lr <= rr
        ? pickLeft(s, { autoInsertEnabled: false })
        : pickRight(s, { autoInsertEnabled: false });
    }
    expect(s.done).toBe(true);
    expect(s.toBeInserted).toContain('g');
    s = manualInsert(s, 'g');
    expect(s.currentManualInsert).not.toBeNull();
    expect(s.currentManualInsert!.insertingId).toBe('g');
    // The peek is the visible (probe, hi] window inside the target
    // sublist — must be a non-empty subset of that sublist.
    const target = s.queue[s.currentManualInsert!.targetQueueIndex];
    const peek = getPeekRightIds(s);
    expect(peek.length).toBeGreaterThan(0);
    for (const id of peek) {
      expect(target).toContain(id);
      expect(id).not.toBe('g'); // never includes the inserting id
    }
  });
});

describe('getPeekLeftIds (merge engine, merge-mode-only)', () => {
  it('walks current.left after the head in normal merge mode', () => {
    const s = seedFromSublists({
      sublists: [[A, B, C], [D, E]],
      extras: [],
    });
    const pair = getPair(s);
    if (pair?.leftId === 'a') {
      // current.left = [a, b, c] → peek after a = [b, c]
      expect(getPeekLeftIds(s)).toEqual(['b', 'c']);
    } else if (pair?.leftId === 'd') {
      // current.left = [d, e] → peek after d = [e]
      expect(getPeekLeftIds(s)).toEqual(['e']);
    } else {
      throw new Error(`unexpected merge pair: ${JSON.stringify(pair)}`);
    }
  });

  it('skips hidden ids and caps at n on the left side', () => {
    const F: Item = { id: 'f', label: 'F' };
    const s0 = seedFromSublists({
      sublists: [[A, B, C, D], [E, F]],
      extras: [],
    });
    const pair = getPair(s0);
    if (pair?.leftId === 'a') {
      // current.left = [a, b, c, d]. Hide c — peek after a = [b, d] (n=3).
      const s1 = hideItem(s0, 'c');
      expect(getPeekLeftIds(s1, 3)).toEqual(['b', 'd']);
      expect(getPeekLeftIds(s0, 1)).toEqual(['b']);
    } else if (pair?.leftId === 'e') {
      const s1 = hideItem(s0, 'f');
      expect(getPeekLeftIds(s1, 3)).toEqual([]);
      expect(getPeekLeftIds(s0, 1)).toEqual(['f']);
    } else {
      throw new Error(`unexpected merge pair: ${JSON.stringify(pair)}`);
    }
  });

  it('returns [] when there is no current merge frame', () => {
    expect(getPeekLeftIds(initSort([A]))).toEqual([]);
    expect(getPeekLeftIds(initSort([]))).toEqual([]);
  });

  it('returns [] in auto-insert mode (single inserting id, no neighbour)', () => {
    // K=1, N=5 → auto-insert installs. The left card is the inserting
    // id alone; there's no rank-adjacent neighbour to fan out, so the
    // helper short-circuits to [] regardless of any stale merge state.
    const F: Item = { id: 'f', label: 'F' };
    const s = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    expect(s.currentAutoInsert).not.toBeNull();
    expect(getPeekLeftIds(s)).toEqual([]);
  });

  it('returns [] in manual-insert mode (single inserting id, no neighbour)', () => {
    const F: Item = { id: 'f', label: 'F' };
    const G: Item = { id: 'g', label: 'G' };
    const H: Item = { id: 'h', label: 'H' };
    let s: MergeState = seedFromSublists({
      sublists: [
        [A, B, C, D, E],
        [F, G, H],
      ],
      extras: [],
    });
    s = hideItem(s, 'g', { autoInsertEnabled: false });
    const order = ['a', 'b', 'c', 'f', 'd', 'e', 'g', 'h'];
    const rank = new Map(order.map((id, i) => [id, i]));
    let safety = 200;
    while (!s.done && safety-- > 0) {
      const p = getPair(s);
      if (!p) break;
      const lr = rank.get(p.leftId) ?? Number.MAX_SAFE_INTEGER;
      const rr = rank.get(p.rightId) ?? Number.MAX_SAFE_INTEGER;
      s = lr <= rr
        ? pickLeft(s, { autoInsertEnabled: false })
        : pickRight(s, { autoInsertEnabled: false });
    }
    s = manualInsert(s, 'g');
    expect(s.currentManualInsert).not.toBeNull();
    expect(getPeekLeftIds(s)).toEqual([]);
  });
});
