import type { InsertFrame, ItemId } from './types';

/**
 * Pure binary-insertion state machine. Shared between the insertion
 * engine (in `insertionSort.ts`) and the deferred manual-insert mini-sessions
 * on the merge engine (in `queueMergeSort.ts`).
 *
 * The caller maintains the `sorted` array externally. This module only
 * advances `lo/hi/probe` until the position is determined, then returns
 * `{ done: true; position }` so the caller can splice.
 *
 * Convention: `insertingId` is conceptually on the LEFT in the UI;
 * `sorted[probe]` is on the RIGHT. picking 'inserting' (left card)
 * means "inserting beats probe" → narrow upward (hi = probe - 1).
 * picking 'sorted' (right card) means "probe beats inserting" → narrow
 * downward (lo = probe + 1).
 */

export type InsertResult =
  | InsertFrame
  | { done: true; position: number };

/**
 * Begin inserting `insertingId` into `sorted` within `[lo, hi]` inclusive.
 *
 * Defaults to the full range. If `lo > hi`, the bounds already pin the
 * position with zero comparisons — returns `{ done: true; position: lo }`.
 */
export function startInsert(
  sorted: ReadonlyArray<ItemId>,
  insertingId: ItemId,
  lo: number = 0,
  hi: number = sorted.length - 1,
): InsertResult {
  if (lo > hi) {
    // Bounds collapsed before any probe — caller can splice at `lo`.
    return { done: true, position: lo };
  }
  // Clamp defensively — calls into corrupt state shouldn't crash.
  const clampedLo = Math.max(0, lo);
  const clampedHi = Math.min(sorted.length - 1, hi);
  if (clampedLo > clampedHi) {
    return { done: true, position: clampedLo };
  }
  const probe = (clampedLo + clampedHi) >> 1;
  return {
    insertingId,
    lo: clampedLo,
    hi: clampedHi,
    probe,
  };
}

/**
 * Apply one user pick to the active frame. Returns either the next
 * frame or `{ done; position }` when bounds collapse.
 */
export function applyInsertPick(
  frame: InsertFrame,
  picked: 'inserting' | 'sorted',
): InsertResult {
  let { lo, hi } = frame;
  const { probe } = frame;
  if (picked === 'inserting') {
    hi = probe - 1;
  } else {
    lo = probe + 1;
  }
  if (lo > hi) {
    return { done: true, position: lo };
  }
  return {
    insertingId: frame.insertingId,
    lo,
    hi,
    probe: (lo + hi) >> 1,
  };
}

/**
 * The pair the UI should display for this frame: inserting on the left,
 * the probed sorted item on the right.
 */
export function getInsertPair(
  frame: InsertFrame,
  sorted: ReadonlyArray<ItemId>,
): { leftId: ItemId; rightId: ItemId } | null {
  if (frame.probe < 0 || frame.probe >= sorted.length) return null;
  return { leftId: frame.insertingId, rightId: sorted[frame.probe] };
}

/**
 * Up to `n` rank-adjacent visible ids in `sorted` immediately after the
 * current probe, capped at `frame.hi` (the active range's upper bound).
 *
 * Drives the peek-deck UI behind the right comparison card: when the
 * user is comparing inserting=A against probe=B, these are the items
 * that B is currently bracketing on its lower-rank side. They aren't
 * the next binary-search probes (those bisect the new range) — picking
 * rank-adjacent matches the user's mental model of "A goes BETWEEN B
 * and C" where C is the next-ranked item below B.
 *
 * Hidden ids are skipped in place; the walk stops when either we've
 * collected `n` visible ids or we've passed `frame.hi`.
 */
export function getInsertPeekRightIds(
  frame: InsertFrame,
  sorted: ReadonlyArray<ItemId>,
  hidden: ReadonlySet<ItemId>,
  n: number,
): ItemId[] {
  const out: ItemId[] = [];
  for (let i = frame.probe + 1; i <= frame.hi && out.length < n; i++) {
    const id = sorted[i];
    if (id && !hidden.has(id)) out.push(id);
  }
  return out;
}

/** Visible rank-adjacent ids after the probe minus the `labeledDepth` shown as named peek cards. */
export function countInsertPeekRightOverflow(
  frame: InsertFrame,
  sorted: ReadonlyArray<ItemId>,
  hidden: ReadonlySet<ItemId>,
  labeledDepth: number,
): number {
  let total = 0;
  for (let i = frame.probe + 1; i <= frame.hi; i++) {
    const id = sorted[i];
    if (id && !hidden.has(id)) total++;
  }
  return Math.max(0, total - labeledDepth);
}

/**
 * Worst-case comparisons remaining from this frame, including the next
 * probe. Used by progress-bar denominators. `⌈log2(hi - lo + 2)⌉`.
 */
export function insertComparisonsRemaining(frame: InsertFrame): number {
  const range = frame.hi - frame.lo + 1; // number of candidate slots after probe collapses
  if (range <= 0) return 0;
  return Math.ceil(Math.log2(range + 1));
}

/**
 * Worst-case comparisons to binary-insert ONE item into a `sortedLen`-long
 * list with the given bounds. Used at plan-time to seed
 * `totalComparisonsEverNeeded` and at addItem-time to bump it. With
 * default bounds (full range), this is `⌈log2(sortedLen + 1)⌉`.
 */
export function worstCaseInsertCost(
  sortedLen: number,
  lo: number = 0,
  hi: number = sortedLen - 1,
): number {
  const range = Math.min(hi, sortedLen - 1) - Math.max(lo, 0) + 1;
  if (range <= 0) return 0;
  return Math.ceil(Math.log2(range + 1));
}

/**
 * Sum the per-item worst-case insert costs for a FIFO plan of `k` items
 * draining into a `l`-item sorted list. After item `i` (0-indexed) lands,
 * the next item inserts into a sorted of size `l + i + 1`, so its cost
 * is `⌈log2(l + i + 2)⌉`. Total: Σ for i in [0, k).
 */
export function sumLog2InsertCosts(l: number, k: number): number {
  let total = 0;
  for (let i = 0; i < k; i++) {
    total += worstCaseInsertCost(l + i);
  }
  return total;
}
