import { describe, expect, it } from 'vitest';
import {
  addItem,
  appendPreRankedSublist,
  breakApartSublist,
  comparisonsRemaining,
  getPair,
  getRanking,
  hideItem,
  initSort,
  mergesRemaining,
  pickLeft,
  pickRight,
  reorderInSublist,
  restoreProgress,
  seedFromSublists,
  snapshotProgress,
  unhideItem,
} from '../queueMergeSort';
import type { Item, SortState } from '../types';

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
): SortState {
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
