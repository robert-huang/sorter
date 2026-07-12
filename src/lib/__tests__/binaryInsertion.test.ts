import { describe, expect, it } from 'vitest';
import {
  applyInsertPick,
  getInsertPair,
  insertComparisonsRemaining,
  reorderDisturbsInsertFrame,
  skipHiddenInsertProbes,
  startInsert,
  sumLog2InsertCosts,
  visibleInsertWindowEndpoints,
  worstCaseInsertCost,
  type InsertResult,
} from '../binaryInsertion';
import type { InsertFrame, ItemId } from '../types';

describe('reorderDisturbsInsertFrame', () => {
  // Active window [lo=3, hi=5]: indices 0-2 rank above, 6+ rank below.
  const frame: InsertFrame = { insertingId: 'x', lo: 3, hi: 5, probe: 4 };

  it('is safe (false) when both indices sit above the window', () => {
    expect(reorderDisturbsInsertFrame(frame, 0, 1)).toBe(false);
    expect(reorderDisturbsInsertFrame(frame, 2, 0)).toBe(false);
  });

  it('is safe (false) when both indices sit below the window', () => {
    expect(reorderDisturbsInsertFrame(frame, 6, 7)).toBe(false);
    expect(reorderDisturbsInsertFrame(frame, 8, 6)).toBe(false);
  });

  it('disturbs (true) when a swap touches the window or its endpoints', () => {
    expect(reorderDisturbsInsertFrame(frame, 3, 4)).toBe(true); // inside
    expect(reorderDisturbsInsertFrame(frame, 2, 3)).toBe(true); // onto lo
    expect(reorderDisturbsInsertFrame(frame, 5, 6)).toBe(true); // off hi
  });

  it('disturbs (true) when a swap crosses the window (above ↔ below)', () => {
    expect(reorderDisturbsInsertFrame(frame, 0, 7)).toBe(true);
  });
});

function isDone(
  r: InsertResult,
): r is { done: true; position: number } {
  return 'done' in r && r.done === true;
}

/**
 * Run a binary insert against a deterministic oracle. Returns
 * { position, prompts } after the insert resolves.
 */
function runInsert(
  sorted: ItemId[],
  insertingId: ItemId,
  oracle: (probe: ItemId) => 'inserting' | 'sorted',
  lo?: number,
  hi?: number,
): { position: number; prompts: number } {
  let res = startInsert(sorted, insertingId, lo, hi);
  let prompts = 0;
  let safety = 100;
  while (!isDone(res) && safety-- > 0) {
    const probeId = sorted[res.probe];
    prompts += 1;
    res = applyInsertPick(res, oracle(probeId), sorted.length);
  }
  if (!isDone(res)) throw new Error('insert did not terminate');
  return { position: res.position, prompts };
}

describe('startInsert', () => {
  it('returns the first probe at the midpoint of the full range by default', () => {
    const res = startInsert(['a', 'b', 'c', 'd', 'e'], 'x');
    expect(isDone(res)).toBe(false);
    if (isDone(res)) return;
    expect(res.lo).toBe(0);
    expect(res.hi).toBe(4);
    expect(res.probe).toBe(2);
    expect(res.insertingId).toBe('x');
  });

  it('collapses immediately to {done, position: lo} when lo > hi (zero-comparison case)', () => {
    const res = startInsert(['a', 'b', 'c'], 'x', 1, 0);
    expect(isDone(res)).toBe(true);
    if (!isDone(res)) return;
    expect(res.position).toBe(1);
  });

  it('collapses immediately on an empty sorted (hi = -1)', () => {
    const res = startInsert([], 'x');
    expect(isDone(res)).toBe(true);
    if (!isDone(res)) return;
    expect(res.position).toBe(0);
  });

  it('respects tight bounds', () => {
    const res = startInsert(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'x', 3, 5);
    expect(isDone(res)).toBe(false);
    if (isDone(res)) return;
    expect(res.lo).toBe(3);
    expect(res.hi).toBe(5);
    expect(res.probe).toBe(4);
  });
});

describe('applyInsertPick', () => {
  it("picking 'inserting' narrows the upper bound (hi = probe - 1)", () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 6, probe: 3 };
    const next = applyInsertPick(frame, 'inserting');
    expect(isDone(next)).toBe(false);
    if (isDone(next)) return;
    expect(next.lo).toBe(0);
    expect(next.hi).toBe(2);
    expect(next.probe).toBe(1);
  });

  it("picking 'sorted' narrows the lower bound (lo = probe + 1)", () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 6, probe: 3 };
    const next = applyInsertPick(frame, 'sorted');
    expect(isDone(next)).toBe(false);
    if (isDone(next)) return;
    expect(next.lo).toBe(4);
    expect(next.hi).toBe(6);
    expect(next.probe).toBe(5);
  });

  it('returns {done, position} when the next pick collapses bounds', () => {
    // lo=2, hi=2, probe=2. Either pick collapses.
    const frame: InsertFrame = { insertingId: 'x', lo: 2, hi: 2, probe: 2 };
    const left = applyInsertPick(frame, 'inserting', 5);
    expect(isDone(left)).toBe(true);
    if (!isDone(left)) return;
    expect(left.position).toBe(2);

    const right = applyInsertPick(frame, 'sorted', 5);
    expect(isDone(right)).toBe(true);
    if (!isDone(right)) return;
    expect(right.position).toBe(3);
  });

  it('returns done when sorted pick pins lo at sorted.length (append)', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 4, hi: 5, probe: 5 };
    const next = applyInsertPick(frame, 'sorted', 6);
    expect(isDone(next)).toBe(true);
    if (!isDone(next)) return;
    expect(next.position).toBe(6);
  });
});

describe('skipHiddenInsertProbes', () => {
  it('resolves a collapsed append frame (probe past tail)', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 56, hi: 56, probe: 56 };
    const sorted = Array.from({ length: 56 }, (_, i) => `id-${i}`);
    const res = skipHiddenInsertProbes(frame, sorted, new Set());
    expect(isDone(res)).toBe(true);
    if (!isDone(res)) return;
    expect(res.position).toBe(56);
  });
});

describe('visibleInsertWindowEndpoints', () => {
  it('returns first/last visible ids inside [lo, hi]', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 1, hi: 4, probe: 2 };
    const sorted = ['a', 'b', 'c', 'd', 'e'];
    expect(visibleInsertWindowEndpoints(frame, sorted, new Set())).toEqual({
      loId: 'b',
      hiId: 'e',
    });
  });

  it('skips hidden endpoints inward', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 3, probe: 2 };
    const sorted = ['a', 'b', 'c', 'd'];
    const hidden = new Set(['a', 'd']);
    expect(visibleInsertWindowEndpoints(frame, sorted, hidden)).toEqual({
      loId: 'b',
      hiId: 'c',
    });
  });
});

describe('end-to-end binary insert', () => {
  it('inserts at position 0 when oracle always picks inserting', () => {
    const sorted = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { position, prompts } = runInsert(sorted, 'x', () => 'inserting');
    expect(position).toBe(0);
    // ceil(log2(7+1)) = 3
    expect(prompts).toBe(3);
  });

  it('inserts at position sorted.length when oracle always picks sorted', () => {
    const sorted = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { position, prompts } = runInsert(sorted, 'x', () => 'sorted');
    expect(position).toBe(7);
    expect(prompts).toBe(3);
  });

  it('lexicographic oracle places x correctly across a 5-item sorted', () => {
    const sorted = ['a', 'b', 'c', 'd', 'e'];
    // 'cc' goes between 'c' and 'd' → position 3
    const oracle = (probe: ItemId): 'inserting' | 'sorted' =>
      'cc' < probe ? 'inserting' : 'sorted';
    const { position } = runInsert(sorted, 'cc', oracle);
    expect(position).toBe(3);
  });

  it('terminates in at most ⌈log2(range + 1)⌉ prompts for any deterministic oracle', () => {
    const sorted = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i));
    const oracle = (probe: ItemId): 'inserting' | 'sorted' =>
      'm' < probe ? 'inserting' : 'sorted'; // 'm' > all current items
    const { prompts, position } = runInsert(sorted, 'm', oracle);
    expect(position).toBe(10);
    // ceil(log2(10+1)) = 4
    expect(prompts).toBeLessThanOrEqual(4);
  });

  it('tight bounds (lo=4, hi=5) terminate in 2 prompts max (3 candidate positions)', () => {
    const sorted = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    // Force the inserted 'x' into range [4, 5] — 3 candidate slots (4, 5, 6).
    const oracle = (probe: ItemId): 'inserting' | 'sorted' => {
      if (probe === 'e') return 'sorted';   // x > e → lo = 5
      if (probe === 'f') return 'sorted';   // x > f → lo = 6
      return 'sorted';
    };
    const { prompts, position } = runInsert(sorted, 'x', oracle, 4, 5);
    expect(prompts).toBeLessThanOrEqual(2);
    expect(position).toBe(6);
  });
});

describe('getInsertPair', () => {
  it('returns inserting on the left, probed sorted item on the right', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 4, probe: 2 };
    const pair = getInsertPair(frame, ['a', 'b', 'c', 'd', 'e']);
    expect(pair).toEqual({ leftId: 'x', rightId: 'c' });
  });

  it('returns null if probe is out of range', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 0, probe: 10 };
    expect(getInsertPair(frame, ['a'])).toBeNull();
  });
});

describe('worstCaseInsertCost / sumLog2InsertCosts', () => {
  it('worst case for full range = ⌈log2(N + 1)⌉', () => {
    expect(worstCaseInsertCost(0)).toBe(0); // empty sorted
    expect(worstCaseInsertCost(1)).toBe(1);
    expect(worstCaseInsertCost(7)).toBe(3);
    expect(worstCaseInsertCost(8)).toBe(4); // ceil(log2(9)) = 4
  });

  it('worst case with tight bounds uses the bounded range, not full N', () => {
    // sortedLen=10, but bounds [4, 5] → range = 2 → ceil(log2(3)) = 2
    expect(worstCaseInsertCost(10, 4, 5)).toBe(2);
  });

  it('sumLog2InsertCosts L=10, K=3 sums consecutive costs', () => {
    // i=0: ceil(log2(11)) = 4
    // i=1: ceil(log2(12)) = 4
    // i=2: ceil(log2(13)) = 4
    expect(sumLog2InsertCosts(10, 3)).toBe(12);
  });

  it('sumLog2InsertCosts L=0, K=3 (insertions into an empty list)', () => {
    // i=0: ceil(log2(1)) = 0  (first insert is free — empty sorted)
    // i=1: ceil(log2(2)) = 1
    // i=2: ceil(log2(3)) = 2
    expect(sumLog2InsertCosts(0, 3)).toBe(3);
  });
});

describe('insertComparisonsRemaining', () => {
  it('full-range frame matches worstCaseInsertCost', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 6, probe: 3 };
    expect(insertComparisonsRemaining(frame)).toBe(worstCaseInsertCost(7));
  });

  it('tight 1-slot frame (lo == hi) has 1 prompt remaining', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 4, hi: 4, probe: 4 };
    expect(insertComparisonsRemaining(frame)).toBe(1);
  });
});
