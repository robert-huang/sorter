import type {
  Item,
  ItemId,
  SortProgress,
  SortState,
} from './types';

// ---------- helpers ----------

/**
 * Returns the index of the first id in `ids` not in `hidden`, or -1 if none.
 */
function firstVisibleIndex(ids: ItemId[], hidden: ReadonlySet<ItemId>): number {
  for (let i = 0; i < ids.length; i++) {
    if (!hidden.has(ids[i])) return i;
  }
  return -1;
}

function countVisible(ids: ItemId[], hidden: ReadonlySet<ItemId>): number {
  let n = 0;
  for (const id of ids) if (!hidden.has(id)) n++;
  return n;
}

/**
 * Public helper: returns the pair of visible ids currently being compared, or
 * null when there is no active merge (or one side has nothing visible).
 */
export function getPair(state: SortState): { leftId: ItemId; rightId: ItemId } | null {
  if (!state.current) return null;
  const hidden = new Set(state.hidden);
  const li = firstVisibleIndex(state.current.left, hidden);
  const ri = firstVisibleIndex(state.current.right, hidden);
  if (li < 0 || ri < 0) return null;
  return { leftId: state.current.left[li], rightId: state.current.right[ri] };
}

/**
 * Exact remaining merge count.
 *
 * Each merge takes 2 sublists from the queue and produces 1 — net -1. When
 * `current` is non-null, 2 sublists have been popped into the in-flight
 * merge (still owed), so they count toward the work remaining.
 *
 * Total logical sublists in the system = queue.length + (current ? 2 : 0).
 * To collapse to 1 final sublist we need (total - 1) merges.
 *
 * Kept around for tests / debugging — UI uses `comparisonsRemaining` now.
 */
export function mergesRemaining(state: SortState): number {
  if (state.done) return 0;
  return Math.max(0, state.queue.length + (state.current ? 2 : 0) - 1);
}

/**
 * Worst-case comparisons remaining from the current state. Simulates the
 * upcoming FIFO merges using visible-item counts:
 *  - cost(merge of size a vs b) = a + b - 1 when both > 0, else 0
 *  - result sublist size = a + b
 *
 * Exact upper bound (never undercounts). Actual comparisons made may be
 * fewer when merges auto-complete early — the progress bar takes the diff,
 * which manifests as the bar jumping forward.
 */
export function comparisonsRemaining(state: SortState): number {
  if (state.done) return 0;
  const hidden = new Set(state.hidden);
  return comparisonsRemainingFromProgress(state, hidden);
}

function comparisonsRemainingFromProgress(
  progress: SortProgress,
  hidden: ReadonlySet<ItemId>,
): number {
  if (progress.done) return 0;
  const sizes: number[] = progress.queue.map((sub) => countVisible(sub, hidden));
  let total = 0;
  if (progress.current) {
    const lv = countVisible(progress.current.left, hidden);
    const rv = countVisible(progress.current.right, hidden);
    const mv = countVisible(progress.current.merged, hidden);
    total += lv > 0 && rv > 0 ? lv + rv - 1 : 0;
    sizes.push(mv + lv + rv);
  }
  while (sizes.length >= 2) {
    const a = sizes.shift()!;
    const b = sizes.shift()!;
    total += a > 0 && b > 0 ? a + b - 1 : 0;
    sizes.push(a + b);
  }
  return total;
}

/**
 * Final ranking when done. Filters out hidden ids.
 */
export function getRanking(state: SortState): ItemId[] {
  if (!state.done || state.queue.length === 0) return [];
  const hidden = new Set(state.hidden);
  return state.queue[0].filter((id) => !hidden.has(id));
}

// ---------- snapshot ----------

/**
 * Snapshot the mutable progress slice (no items dict). structuredClone
 * gives us a deep, independent copy for the undo ring.
 */
export function snapshotProgress(state: SortState): SortProgress {
  return {
    queue: state.queue.map((sub) => sub.slice()),
    current: state.current
      ? {
          left: state.current.left.slice(),
          right: state.current.right.slice(),
          merged: state.current.merged.slice(),
        }
      : null,
    comparisons: state.comparisons,
    done: state.done,
    hidden: state.hidden.slice(),
    totalComparisonsEverNeeded: state.totalComparisonsEverNeeded,
  };
}

/**
 * Apply a snapshotted progress back onto a state (keeps items dict).
 */
export function restoreProgress(
  state: SortState,
  progress: SortProgress,
): SortState {
  return {
    ...progress,
    queue: progress.queue.map((sub) => sub.slice()),
    current: progress.current
      ? {
          left: progress.current.left.slice(),
          right: progress.current.right.slice(),
          merged: progress.current.merged.slice(),
        }
      : null,
    hidden: progress.hidden.slice(),
    items: state.items,
  };
}

// ---------- advance ----------

/**
 * Internal: pull the next merge frame off the queue, skipping degenerate
 * frames (where one or both sides have zero visible candidates because all
 * their items have been hidden).
 *
 * Mutates the passed-in progress slice in place; caller must already have
 * snapshotted the prior state if undo is desired.
 */
function advance(progress: SortProgress, hidden: ReadonlySet<ItemId>): void {
  // Loop because each "trivial" merge may expose another trivial pair.
  while (progress.current === null) {
    if (progress.queue.length <= 1) {
      progress.done = true;
      return;
    }
    const left = progress.queue.shift()!;
    const right = progress.queue.shift()!;
    const leftVisible = countVisible(left, hidden);
    const rightVisible = countVisible(right, hidden);

    if (leftVisible === 0 && rightVisible === 0) {
      // Both sides are entirely hidden; produce a (still entirely-hidden)
      // merged sublist and push to back. Doesn't change visible ranking.
      progress.queue.push(left.concat(right));
      continue;
    }
    if (leftVisible === 0) {
      // Left has nothing visible: right wins by default; push right
      // (concatenated with left's hidden tail to preserve ids for undo).
      progress.queue.push(right.concat(left));
      continue;
    }
    if (rightVisible === 0) {
      progress.queue.push(left.concat(right));
      continue;
    }
    progress.current = { left, right, merged: [] };
    progress.done = false;
    return;
  }
  // Has a current frame already; nothing to do.
}

/**
 * Internal: after a pick, if one side of `current` has no more visible
 * candidates, flush the merge (append the other side's remainder, push to
 * back of queue, clear current, advance to next frame).
 */
function flushIfMergeComplete(
  progress: SortProgress,
  hidden: ReadonlySet<ItemId>,
): void {
  if (!progress.current) return;
  const { left, right, merged } = progress.current;
  const leftVisible = countVisible(left, hidden);
  const rightVisible = countVisible(right, hidden);
  if (leftVisible > 0 && rightVisible > 0) return;

  // One (or both) sides empty of visible — close out the merge.
  // We append both raw arrays so any hidden ids inside ride along.
  const closed = merged.concat(left, right);
  progress.queue.push(closed);
  progress.current = null;
  advance(progress, hidden);
}

// ---------- public transitions ----------

/**
 * Sort-from-scratch entry point. Initial queue = N singletons in input order.
 */
export function initSort(items: Item[]): SortState {
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of items) itemsDict[it.id] = it;

  const queue = items.map((it) => [it.id]);
  const progress: SortProgress = {
    queue,
    current: null,
    comparisons: 0,
    done: false,
    hidden: [],
    totalComparisonsEverNeeded: 0,
  };
  advance(progress, new Set());
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(
    progress,
    new Set(),
  );
  return { ...progress, items: itemsDict };
}

/**
 * Merge-pre-ranked-lists entry point. Extras (unranked) go to the FRONT of
 * the queue as singletons; pre-ranked sublists follow.
 */
export function seedFromSublists(args: {
  sublists: Item[][];
  extras: Item[];
}): SortState {
  const { sublists, extras } = args;
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of extras) itemsDict[it.id] = it;
  for (const sub of sublists) for (const it of sub) itemsDict[it.id] = it;

  const queue: ItemId[][] = [];
  for (const it of extras) queue.push([it.id]);
  for (const sub of sublists) queue.push(sub.map((it) => it.id));

  const progress: SortProgress = {
    queue,
    current: null,
    comparisons: 0,
    done: false,
    hidden: [],
    totalComparisonsEverNeeded: 0,
  };
  advance(progress, new Set());
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(
    progress,
    new Set(),
  );
  return { ...progress, items: itemsDict };
}

function bumpTotalComparisons(progress: SortProgress): void {
  const current = comparisonsRemainingFromProgress(
    progress,
    new Set(progress.hidden),
  );
  if (current > progress.totalComparisonsEverNeeded) {
    progress.totalComparisonsEverNeeded = current;
  }
}

/**
 * Pick the visible head of `left` or `right`. Mutating `pick` helper used by
 * both pickLeft and pickRight. Returns a brand-new SortState.
 */
function applyPick(state: SortState, side: 'left' | 'right'): SortState {
  if (!state.current) return state;
  const hidden = new Set(state.hidden);
  const li = firstVisibleIndex(state.current.left, hidden);
  const ri = firstVisibleIndex(state.current.right, hidden);
  if (li < 0 || ri < 0) return state;

  const next = snapshotProgress(state);
  const frame = next.current!;
  const sourceArr = side === 'left' ? frame.left : frame.right;
  const sourceIdx = side === 'left' ? li : ri;
  // Take ids from the head through the picked one. Anything before the
  // picked one is hidden; we keep them (in merged) so undo can resurrect
  // them in their original visual position.
  const taken = sourceArr.splice(0, sourceIdx + 1);
  frame.merged.push(...taken);
  next.comparisons += 1;
  flushIfMergeComplete(next, hidden);
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

export function pickLeft(state: SortState): SortState {
  return applyPick(state, 'left');
}
export function pickRight(state: SortState): SortState {
  return applyPick(state, 'right');
}

/**
 * Hide an item (remove from contention). Reversible via undo. If hiding
 * empties one side of the current merge, the merge auto-closes.
 */
export function hideItem(state: SortState, id: ItemId): SortState {
  if (!state.items[id]) return state;
  if (state.hidden.includes(id)) return state;

  const next = snapshotProgress(state);
  next.hidden = [...next.hidden, id].sort();
  const hiddenSet = new Set(next.hidden);
  flushIfMergeComplete(next, hiddenSet);
  // Re-check done in case hiding completed the last merge.
  if (next.queue.length <= 1 && next.current === null) {
    next.done = true;
  }
  return { ...next, items: state.items };
}

/**
 * Unhide a previously hidden item. If we were `done` and the unhidden item
 * sits alone, it just reappears in the rank. If we were `done` with the
 * unhidden item inside the only remaining sublist, it's already part of the
 * order so no further work. (No new comparisons are introduced by unhiding;
 * we don't re-sort the item against others.)
 */
export function unhideItem(state: SortState, id: ItemId): SortState {
  if (!state.hidden.includes(id)) return state;

  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

/**
 * Add a brand-new item mid-sort (or after `done`). Pushes a singleton to the
 * back of the queue. If currently done, flips back to not-done and advances.
 * Refuses if an item with this canonical key already exists (caller
 * should detect and surface a friendly message).
 */
export function addItem(state: SortState, item: Item): SortState | null {
  if (state.items[item.id]) return null;

  const next = snapshotProgress(state);
  next.queue.push([item.id]);
  if (next.done) {
    next.done = false;
  }
  advance(next, new Set(next.hidden));
  bumpTotalComparisons(next);

  return {
    ...next,
    items: { ...state.items, [item.id]: item },
  };
}

/**
 * Append a new pre-ranked sublist to the back of the queue. Items not yet in
 * the state are added; items already present (by id) are skipped from the
 * new sublist but get URL/IMAGE fields filled in if the existing record
 * lacks them (consistent with parse-time dedup behavior). Returns the new
 * state plus a list of skipped item ids for UI feedback.
 */
export function appendPreRankedSublist(
  state: SortState,
  items: Item[],
): { state: SortState; skipped: ItemId[] } {
  const next = snapshotProgress(state);
  const itemsDict = { ...state.items };
  const skipped: ItemId[] = [];
  const newSublistIds: ItemId[] = [];

  for (const it of items) {
    const existing = itemsDict[it.id];
    if (existing) {
      skipped.push(it.id);
      const merged: Item = {
        ...existing,
        url: existing.url ?? it.url,
        imageUrl: existing.imageUrl ?? it.imageUrl,
      };
      itemsDict[it.id] = merged;
    } else {
      itemsDict[it.id] = it;
      newSublistIds.push(it.id);
    }
  }

  if (newSublistIds.length > 0) {
    next.queue.push(newSublistIds);
    if (next.done) {
      next.done = false;
    }
    advance(next, new Set(next.hidden));
    bumpTotalComparisons(next);
  }

  return {
    state: { ...next, items: itemsDict },
    skipped,
  };
}

/**
 * Move an item up or down within a queued sublist. queueIndex addresses
 * `state.queue` — currently-merging sublists live in `current` and are
 * naturally excluded. direction: -1 = up (toward index 0), +1 = down.
 */
export function reorderInSublist(
  state: SortState,
  queueIndex: number,
  itemIndex: number,
  direction: -1 | 1,
): SortState {
  if (queueIndex < 0 || queueIndex >= state.queue.length) return state;
  const sub = state.queue[queueIndex];
  const target = itemIndex + direction;
  if (itemIndex < 0 || itemIndex >= sub.length) return state;
  if (target < 0 || target >= sub.length) return state;

  const next = snapshotProgress(state);
  const newSub = next.queue[queueIndex].slice();
  [newSub[itemIndex], newSub[target]] = [newSub[target], newSub[itemIndex]];
  next.queue[queueIndex] = newSub;
  return { ...next, items: state.items };
}

/**
 * Destroy a sublist: pop it out of its queue position and push each of its
 * ids back as a singleton sublist at the END of the queue. Equivalent to
 * "I want these all re-sorted from scratch." No-op for single-item sublists.
 */
export function breakApartSublist(
  state: SortState,
  queueIndex: number,
): SortState {
  if (queueIndex < 0 || queueIndex >= state.queue.length) return state;
  const sub = state.queue[queueIndex];
  if (sub.length <= 1) return state;

  const next = snapshotProgress(state);
  next.queue.splice(queueIndex, 1);
  for (const id of sub) next.queue.push([id]);
  if (next.done && next.queue.length > 1) {
    next.done = false;
  }
  advance(next, new Set(next.hidden));
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}
