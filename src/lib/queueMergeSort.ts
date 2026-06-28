import {
  applyInsertPick,
  getInsertPair,
  countInsertPeekRightOverflow,
  getInsertPeekRightIds,
  insertComparisonsRemaining,
  startInsert,
  startRankAwareInsert,
} from './binaryInsertion';
import { shuffledCopy } from './shuffle';
import type {
  AutoInsertFrame,
  Item,
  ItemId,
  ManualInsertFrame,
  MergeProgress,
  MergeState,
} from './types';

/**
 * Options passed through every public mutator that may call `advance()`.
 * Settings live in the App layer (Settings store + gear menu toggle) and
 * get threaded down to engine entry points each call. Keeping it as a
 * per-call arg (rather than on the state) means undo never accidentally
 * reverts a user's toggle.
 */
export interface MergeOptions {
  /**
   * When true (default), `advance()` may install an auto-insert frame
   * instead of a normal merge frame when the popped pair is skewed
   * enough that binary insertion beats the full merge. Set false to
   * force every pair through the classic merge.
   *
   * Correctness contract: auto-insert assumes the smaller side is in
   * true rank order. That holds for sublists produced by merges (which
   * are correct by construction) and for sublists the user has
   * explicitly opted in as pre-ranked (via the "Treat as pre-ranked"
   * checkbox or the pre-ranked seed flow). If the user asserts
   * pre-ranked-ness untruthfully (e.g., paste an alphabetical CSV and
   * tick the checkbox), auto-insert will silently produce a wrong
   * final ranking. The Settings toggle exists for users who want the
   * conservative behavior.
   */
  autoInsertEnabled?: boolean;
  /**
   * When true (default), randomize item order once before building the
   * initial singleton queue in `initSort` (and the extras list in
   * `seedFromSublists`). CSV paste order is often alphabetical, which
   * would otherwise make the first several comparisons feel like "is
   * A before B?", "is C before D?", etc. One startup shuffle breaks
   * that pattern without affecting merge correctness.
   */
  shuffleAtStart?: boolean;
  /** Injectable RNG (tests only). Defaults to `Math.random`. */
  random?: () => number;
}

const DEFAULT_OPTIONS: Required<Omit<MergeOptions, 'random'>> & {
  random: () => number;
} = {
  autoInsertEnabled: true,
  shuffleAtStart: true,
  random: Math.random,
};

function resolveOptions(opts?: MergeOptions): Required<Omit<MergeOptions, 'random'>> & {
  random: () => number;
} {
  return {
    autoInsertEnabled: opts?.autoInsertEnabled ?? DEFAULT_OPTIONS.autoInsertEnabled,
    shuffleAtStart: opts?.shuffleAtStart ?? DEFAULT_OPTIONS.shuffleAtStart,
    random: opts?.random ?? DEFAULT_OPTIONS.random,
  };
}

/**
 * The auto-insert heuristic. Returns true when binary-inserting the
 * smaller side (K visible items) into the larger side (N visible items)
 * is strictly cheaper than the full merge.
 *
 *   merge cost  = N + K - 1   (worst case, both sides have visible items)
 *   insert cost = K * ⌈log₂(N + K)⌉   (rank-blind worst case; rank-aware
 *                                       bounds in drainAutoInsert make
 *                                       this an upper bound)
 *
 * Examples:
 *   K=1, N=4 → insert=⌈log₂5⌉=3 < merge=4 → auto-insert
 *   K=2, N=8 → insert=2·⌈log₂10⌉=8 < merge=9 → auto-insert
 *   K=3, N=5 → insert=3·⌈log₂8⌉=9 > merge=7 → merge
 *   K=4, N=4 → insert=4·⌈log₂8⌉=12 > merge=7 → merge
 *
 * Conservative: never returns true when merge would in fact be cheaper.
 * May return false (i.e. defer to merge) in some borderline cases where
 * rank-aware bounds would actually make auto-insert win — that's a
 * worthwhile tradeoff because the merge cost formula is exact while the
 * insert cost is a worst-case upper bound.
 */
export function shouldAutoInsert(visibleA: number, visibleB: number): boolean {
  const K = Math.min(visibleA, visibleB);
  const N = Math.max(visibleA, visibleB);
  if (K <= 0 || N <= 0) return false;
  const insertCost = K * Math.ceil(Math.log2(N + K));
  const mergeCost = N + K - 1;
  return insertCost < mergeCost;
}

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
 * Public helper: returns the pair of visible ids currently being compared.
 *
 * Three-stage dispatch (priority: manual insert > auto insert > merge):
 *  - if a user-triggered manual-insert mini-session is active, show its
 *    frame (highest priority — user explicitly chose to insert);
 *  - else if the engine-triggered auto-insert frame is active, show its
 *    current insert's pair;
 *  - else show the in-flight merge.
 *
 * Returns null when none is active (or one side has nothing visible).
 *
 * Invariants:
 *  - at most one of { current, currentManualInsert, currentAutoInsert }
 *    is non-null at any time.
 */
export function getPair(state: MergeState): { leftId: ItemId; rightId: ItemId } | null {
  if (state.currentManualInsert) {
    const target = state.queue[state.currentManualInsert.targetQueueIndex];
    if (!target) return null;
    return getInsertPair(state.currentManualInsert.frame, target);
  }
  if (state.currentAutoInsert && state.currentAutoInsert.frame) {
    return getInsertPair(state.currentAutoInsert.frame, state.currentAutoInsert.target);
  }
  if (!state.current) return null;
  const hidden = new Set(state.hidden);
  const li = firstVisibleIndex(state.current.left, hidden);
  const ri = firstVisibleIndex(state.current.right, hidden);
  if (li < 0 || ri < 0) return null;
  return { leftId: state.current.left[li], rightId: state.current.right[ri] };
}

/**
 * Up to `n` rank-adjacent visible ids on the RIGHT card's side. Dispatch
 * priority matches `getPair`: manual-insert > auto-insert > merge.
 *
 *  - manual-insert: walk `queue[targetQueueIndex]` after the active probe
 *    (rank-adjacent in the target sublist's existing order).
 *  - auto-insert: walk `currentAutoInsert.target` after the active probe.
 *  - merging: walk `current.right` after its first visible head.
 *
 * Returns [] when no compare is active or all candidates are hidden.
 */
export function getPeekRightIds(state: MergeState, n = 3): ItemId[] {
  const hidden = new Set(state.hidden);
  if (state.currentManualInsert) {
    const target = state.queue[state.currentManualInsert.targetQueueIndex];
    if (!target) return [];
    return getInsertPeekRightIds(state.currentManualInsert.frame, target, hidden, n);
  }
  if (state.currentAutoInsert?.frame) {
    return getInsertPeekRightIds(
      state.currentAutoInsert.frame,
      state.currentAutoInsert.target,
      hidden,
      n,
    );
  }
  if (!state.current) return [];
  return peekAfterHead(state.current.right, hidden, n);
}

/**
 * Up to `n` rank-adjacent visible ids on the LEFT card's side. Only
 * meaningful in normal merge mode where the left card is itself the
 * head of a sublist — manual-insert and auto-insert have a single
 * inserting id on the left with no rank-adjacent neighbor, so they
 * always return []. CompareScreen uses [] as the signal to skip
 * rendering a left-side peek deck entirely.
 */
export function getPeekLeftIds(state: MergeState, n = 3): ItemId[] {
  if (state.currentManualInsert || state.currentAutoInsert?.frame) return [];
  if (!state.current) return [];
  const hidden = new Set(state.hidden);
  return peekAfterHead(state.current.left, hidden, n);
}

/**
 * How many visible ids on the right remain after the `labeledDepth`
 * named peek cards (drives the `...n` overflow tail on CompareScreen).
 */
export function getPeekRightOverflowCount(
  state: MergeState,
  labeledDepth: number,
): number {
  const hidden = new Set(state.hidden);
  if (state.currentManualInsert) {
    const target = state.queue[state.currentManualInsert.targetQueueIndex];
    if (!target) return 0;
    return countInsertPeekRightOverflow(
      state.currentManualInsert.frame,
      target,
      hidden,
      labeledDepth,
    );
  }
  if (state.currentAutoInsert?.frame) {
    return countInsertPeekRightOverflow(
      state.currentAutoInsert.frame,
      state.currentAutoInsert.target,
      hidden,
      labeledDepth,
    );
  }
  if (!state.current) return 0;
  return Math.max(
    0,
    countVisibleAfterHead(state.current.right, hidden) - labeledDepth,
  );
}

/**
 * Merge-mode left deck overflow count. [] left peek in insert modes.
 */
export function getPeekLeftOverflowCount(
  state: MergeState,
  labeledDepth: number,
): number {
  if (state.currentManualInsert || state.currentAutoInsert?.frame) return 0;
  if (!state.current) return 0;
  const hidden = new Set(state.hidden);
  return Math.max(
    0,
    countVisibleAfterHead(state.current.left, hidden) - labeledDepth,
  );
}

/**
 * Walk past the first visible (the head shown as A or B) and collect
 * up to `n` more visible ids in queue order. Shared between left and
 * right merge-mode peeks.
 */
function peekAfterHead(
  ids: ReadonlyArray<ItemId>,
  hidden: ReadonlySet<ItemId>,
  n: number,
): ItemId[] {
  const headIdx = firstVisibleIndex(ids as ItemId[], hidden);
  if (headIdx < 0) return [];
  const out: ItemId[] = [];
  for (let i = headIdx + 1; i < ids.length && out.length < n; i++) {
    if (!hidden.has(ids[i])) out.push(ids[i]);
  }
  return out;
}

function countVisibleAfterHead(
  ids: ReadonlyArray<ItemId>,
  hidden: ReadonlySet<ItemId>,
): number {
  const headIdx = firstVisibleIndex(ids as ItemId[], hidden);
  if (headIdx < 0) return 0;
  let count = 0;
  for (let i = headIdx + 1; i < ids.length; i++) {
    if (!hidden.has(ids[i])) count++;
  }
  return count;
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
export function mergesRemaining(state: MergeState): number {
  if (state.done) return 0;
  return Math.max(0, state.queue.length + (state.current ? 2 : 0) - 1);
}

/**
 * Worst-case comparisons remaining from the current state. Simulates the
 * upcoming FIFO merges using visible-item counts:
 *  - cost(merge of size a vs b) = a + b - 1 when both > 0, else 0
 *  - result sublist size = a + b
 *
 * Also adds: the in-flight manual-insert (if any), any pendingManualInserts
 * worst case (estimated against the queue's largest sublist), and the
 * in-flight auto-insert (frame + remaining pendingInserts).
 *
 * Auto-insert future cost (for pairs not yet popped) is folded into the
 * per-pair walk in `comparisonsRemainingFromProgress` — for each pair,
 * choose `min(mergeCost, autoInsertCost)` only when auto-insert is
 * enabled (Phase 2 will pass settings through; for now this only kicks
 * in when an auto-insert frame is already live).
 *
 * Exact upper bound (never undercounts). Actual comparisons made may be
 * fewer when merges auto-complete early or when rank-aware bounds tighten
 * an auto-insert beyond the worst case — the progress bar takes the diff,
 * which manifests as the bar jumping forward.
 */
export function comparisonsRemaining(
  state: MergeState,
  options?: MergeOptions,
): number {
  if (state.done) return 0;
  const hidden = new Set(state.hidden);
  return comparisonsRemainingFromProgress(state, hidden, resolveOptions(options));
}

function comparisonsRemainingFromProgress(
  progress: MergeProgress,
  hidden: ReadonlySet<ItemId>,
  opts: Required<MergeOptions>,
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
  // In-flight auto-insert: the partially-grown target plus everything in
  // pendingInserts will ultimately produce one merged sublist of size
  // (target + pendingInserts.length). Cost = active frame's remaining
  // probes (if any) plus one full-range binary insert per pending item
  // (rank-aware bounds make actuality smaller; we use the conservative
  // rank-blind worst case here for monotonicity of the bar).
  if (progress.currentAutoInsert) {
    const ai = progress.currentAutoInsert;
    if (ai.frame) total += insertComparisonsRemaining(ai.frame);
    let projectedSize = ai.target.length + (ai.frame ? 1 : 0);
    for (let i = 0; i < ai.pendingInserts.length; i++) {
      total += projectedSize > 0 ? Math.ceil(Math.log2(projectedSize + 1)) : 0;
      projectedSize += 1;
    }
    sizes.push(ai.target.length + (ai.frame ? 1 : 0) + ai.pendingInserts.length);
  }
  // Forecast remaining queue pairs. Each pair pays min(merge, auto-insert)
  // when auto-insert is enabled and the heuristic fires; otherwise merge.
  while (sizes.length >= 2) {
    const a = sizes.shift()!;
    const b = sizes.shift()!;
    if (a > 0 && b > 0) {
      const mergeCost = a + b - 1;
      let payCost = mergeCost;
      if (opts.autoInsertEnabled && shouldAutoInsert(a, b)) {
        const K = Math.min(a, b);
        const N = Math.max(a, b);
        // Rank-blind worst-case auto-insert forecast — matches the
        // installAutoInsert path's actual upper bound. Actual count
        // ticks lower as rank-aware bounds tighten each subsequent
        // insert (visible as the progress bar jumping forward).
        const autoInsertCost = K * Math.ceil(Math.log2(N + K));
        payCost = Math.min(mergeCost, autoInsertCost);
      }
      total += payCost;
    }
    sizes.push(a + b);
  }
  // Manual-insert-mini-session cost on top of the merge cost above.
  if (progress.currentManualInsert) {
    total += insertComparisonsRemaining(progress.currentManualInsert.frame);
  }
  // Each queued manual insert costs at most ⌈log2(largestSublist + 1)⌉.
  // Approximate against the largest visible sublist in the queue.
  if (progress.pendingManualInserts.length > 0) {
    const largest = sizes.length > 0
      ? Math.max(...sizes, progress.queue.reduce((m, s) => Math.max(m, countVisible(s, hidden)), 0))
      : progress.queue.reduce((m, s) => Math.max(m, countVisible(s, hidden)), 0);
    const perInsert = largest > 0 ? Math.ceil(Math.log2(largest + 1)) : 1;
    total += progress.pendingManualInserts.length * perInsert;
  }
  return total;
}

/**
 * Final ranking when done. Filters out hidden ids and any items that
 * landed in the `toBeInserted` bucket (those were deliberately set
 * aside by the user — they shouldn't appear in the final rank until
 * the user explicitly inserts them).
 */
export function getRanking(state: MergeState): ItemId[] {
  if (!state.done || state.queue.length === 0) return [];
  const hidden = new Set(state.hidden);
  const toBeInserted = new Set(state.toBeInserted);
  return state.queue[0].filter((id) => !hidden.has(id) && !toBeInserted.has(id));
}

// ---------- snapshot ----------

/**
 * Snapshot the mutable progress slice (no items dict). Deep-copies all
 * arrays so the undo ring is independent of mutations on the live state.
 */
export function snapshotProgress(state: MergeState): MergeProgress {
  return {
    engine: 'merge',
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
    toBeInserted: state.toBeInserted.slice(),
    pendingManualInserts: state.pendingManualInserts.slice(),
    currentManualInsert: cloneManualInsert(state.currentManualInsert),
    currentAutoInsert: cloneAutoInsert(state.currentAutoInsert),
  };
}

/**
 * Apply a snapshotted progress back onto a state (keeps items dict).
 */
export function restoreProgress(
  state: MergeState,
  progress: MergeProgress,
): MergeState {
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
    toBeInserted: progress.toBeInserted.slice(),
    pendingManualInserts: progress.pendingManualInserts.slice(),
    currentManualInsert: cloneManualInsert(progress.currentManualInsert),
    currentAutoInsert: cloneAutoInsert(progress.currentAutoInsert),
    items: state.items,
  };
}

function cloneManualInsert(
  mi: ManualInsertFrame | null,
): ManualInsertFrame | null {
  if (!mi) return null;
  return {
    insertingId: mi.insertingId,
    targetQueueIndex: mi.targetQueueIndex,
    frame: { ...mi.frame },
  };
}

function cloneAutoInsert(
  ai: AutoInsertFrame | null,
): AutoInsertFrame | null {
  if (!ai) return null;
  return {
    target: ai.target.slice(),
    pendingInserts: ai.pendingInserts.slice(),
    frame: ai.frame ? { ...ai.frame } : null,
    lastInsertedPosition: ai.lastInsertedPosition,
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
function advance(
  progress: MergeProgress,
  hidden: ReadonlySet<ItemId>,
  opts: Required<MergeOptions>,
): void {
  // Loop because each "trivial" merge may expose another trivial pair.
  while (progress.current === null && progress.currentAutoInsert === null) {
    if (progress.queue.length <= 1) {
      // Only proceed to done if there are no pending manual inserts either —
      // those still need to drain. If we have pending manual inserts but no
      // queue to drain into, leave them be (they'll surface as an
      // "pending insert, no target sublist" warning at UI level).
      if (
        progress.pendingManualInserts.length === 0 &&
        progress.currentManualInsert === null
      ) {
        progress.done = true;
      }
      return;
    }
    const left = progress.queue.shift()!;
    const right = progress.queue.shift()!;
    const leftVisible = countVisible(left, hidden);
    const rightVisible = countVisible(right, hidden);

    if (leftVisible === 0 && rightVisible === 0) {
      // Both sides entirely hidden — exile both. Same exile rule as
      // flushIfMergeComplete: don't silently position hidden ids.
      exileAndPush(progress, [...left, ...right], hidden);
      continue;
    }
    if (leftVisible === 0) {
      // Left has nothing visible. Right is the only visible content
      // here; exile left's hidden ids and push right verbatim.
      exileAndPush(progress, [...right, ...left], hidden);
      continue;
    }
    if (rightVisible === 0) {
      exileAndPush(progress, [...left, ...right], hidden);
      continue;
    }
    // Heuristic decision: when the popped pair is skewed enough that
    // binary insertion beats the full merge, install an auto-insert
    // frame and drain it. Otherwise fall through to the classic merge
    // install.
    if (
      opts.autoInsertEnabled &&
      shouldAutoInsert(leftVisible, rightVisible)
    ) {
      installAutoInsert(progress, left, right, hidden, opts);
      return;
    }
    progress.current = { left, right, merged: [] };
    progress.done = false;
    return;
  }
  // Has a current frame already; nothing to do.
}

/**
 * Build an AutoInsertFrame from a popped (left, right) pair. The smaller
 * side's visible ids become `pendingInserts` (preserving their input order
 * — which is also the rank order from the pre-ranked seed if any — for
 * rank-aware bound tightening in `drainAutoInsert`). The larger side's
 * visible ids become `target`. Hidden ids from BOTH sides go straight
 * to `toBeInserted` (same exile rule as merge close), since auto-insert
 * doesn't probe hidden ids — keeping them inside the frame would have
 * no useful effect.
 */
function installAutoInsert(
  progress: MergeProgress,
  left: ItemId[],
  right: ItemId[],
  hidden: ReadonlySet<ItemId>,
  opts: Required<MergeOptions>,
): void {
  const leftVisible = countVisible(left, hidden);
  const rightVisible = countVisible(right, hidden);
  const [smallerRaw, largerRaw] = leftVisible <= rightVisible
    ? [left, right]
    : [right, left];
  const target: ItemId[] = [];
  const pendingInserts: ItemId[] = [];
  const exiled: ItemId[] = [];
  for (const id of largerRaw) {
    if (hidden.has(id)) exiled.push(id);
    else target.push(id);
  }
  for (const id of smallerRaw) {
    if (hidden.has(id)) exiled.push(id);
    else pendingInserts.push(id);
  }
  if (exiled.length > 0) progress.toBeInserted.push(...exiled);
  progress.currentAutoInsert = {
    target,
    pendingInserts,
    frame: null,
    lastInsertedPosition: null,
  };
  progress.done = false;
  drainAutoInsert(progress, hidden, opts);
}

/**
 * Push a closed-sublist's visible portion onto the queue, exile its
 * hidden portion into `toBeInserted`. Shared helper used by both `advance`
 * (degenerate-frame collapse) and `flushIfMergeComplete` (normal close).
 */
function exileAndPush(
  progress: MergeProgress,
  all: ItemId[],
  hidden: ReadonlySet<ItemId>,
): void {
  const visible: ItemId[] = [];
  const exiled: ItemId[] = [];
  for (const id of all) {
    if (hidden.has(id)) exiled.push(id);
    else visible.push(id);
  }
  if (visible.length > 0) progress.queue.push(visible);
  if (exiled.length > 0) progress.toBeInserted.push(...exiled);
}

/**
 * Internal: after a pick, if one side of `current` has no more visible
 * candidates, close the merge.
 *
 * Exile rule: items that are currently hidden when the merge closes are
 * moved into `toBeInserted` rather than ride along inside the closed
 * sublist. This avoids silently positioning a hidden item at an
 * arbitrary slot (`{leftover concat}` tail position) — the user
 * inserting them later can use binary insertion to put them where
 * they belong.
 *
 * After closing, drain any queued manual inserts before advancing to the
 * next merge — see drainManualInserts / §5c.
 */
function flushIfMergeComplete(
  progress: MergeProgress,
  hidden: ReadonlySet<ItemId>,
  opts: Required<MergeOptions>,
): void {
  if (!progress.current) return;
  const { left, right, merged } = progress.current;
  const leftVisible = countVisible(left, hidden);
  const rightVisible = countVisible(right, hidden);
  if (leftVisible > 0 && rightVisible > 0) return;
  // Visible portion → back of queue; hidden portion → toBeInserted bucket.
  // (The exile rule, plan §5b: don't silently position hidden ids.)
  exileAndPush(progress, merged.concat(left, right), hidden);
  progress.current = null;
  drainManualInserts(progress, hidden);
  if (!progress.currentManualInsert) {
    advance(progress, hidden, opts);
  }
}

// ---------- manual-insert (deferred-drain mechanic) ----------

interface ManualInsertTarget {
  queueIndex: number;
  sublist: ItemId[];
  lo: number;
  hi: number;
}

/**
 * MVP target chooser. Picks the queue sublist with the most VISIBLE ids
 * and binary-inserts over its full range. Future lineage-tracking
 * optimization (parked todo) can tighten lo/hi using the item's pre-rank
 * neighbors — see plan §5d.
 *
 * Returns null if no queue sublist has any visible content (e.g., queue
 * empty or all sublists fully hidden).
 */
function chooseManualInsertTarget(
  progress: MergeProgress,
  _insertingId: ItemId, // unused in MVP — lineage-tracking would key on this
  hidden: ReadonlySet<ItemId>,
): ManualInsertTarget | null {
  let bestIdx = -1;
  let bestVisible = -1;
  for (let i = 0; i < progress.queue.length; i++) {
    const v = countVisible(progress.queue[i], hidden);
    if (v > bestVisible) {
      bestVisible = v;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestVisible <= 0) return null;
  const sublist = progress.queue[bestIdx];
  return {
    queueIndex: bestIdx,
    sublist,
    lo: 0,
    hi: sublist.length - 1,
  };
}

/**
 * Drain pending manual inserts onto `currentManualInsert`. Called between
 * merges (never mid-merge). May resolve some inserts immediately via
 * zero-comparison splice; loops until either a real frame is installed
 * or pendingManualInserts is empty.
 *
 * Mutates progress in place; caller owns the undo snapshot.
 */
function drainManualInserts(
  progress: MergeProgress,
  hidden: ReadonlySet<ItemId>,
): void {
  if (progress.currentManualInsert) return;
  while (progress.pendingManualInserts.length > 0) {
    const insertingId = progress.pendingManualInserts[0];
    const target = chooseManualInsertTarget(progress, insertingId, hidden);
    if (!target) {
      // No valid target — leave the insert queued. The user can
      // either Forget it or wait for a merge to produce a sublist.
      return;
    }
    const res = startInsert(target.sublist, insertingId, target.lo, target.hi);
    progress.pendingManualInserts.shift();
    if ('done' in res) {
      // Zero-comparison case: bounds collapsed.
      const sub = progress.queue[target.queueIndex];
      progress.queue[target.queueIndex] = [
        ...sub.slice(0, res.position),
        insertingId,
        ...sub.slice(res.position),
      ];
      progress.toBeInserted = progress.toBeInserted.filter((x) => x !== insertingId);
      continue;
    }
    progress.currentManualInsert = {
      insertingId,
      targetQueueIndex: target.queueIndex,
      frame: res,
    };
    return;
  }
}

// ---------- public transitions ----------

function freshMergeProgress(queue: ItemId[][]): MergeProgress {
  return {
    engine: 'merge',
    queue,
    current: null,
    comparisons: 0,
    done: false,
    hidden: [],
    totalComparisonsEverNeeded: 0,
    toBeInserted: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
}

/**
 * Sort-from-scratch entry point. Initial queue = N singletons. Item order
 * is shuffled once at startup (see `shuffleAtStart`) so CSV paste order
 * does not dominate the first comparisons.
 */
export function initSort(items: Item[], options?: MergeOptions): MergeState {
  const opts = resolveOptions(options);
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of items) itemsDict[it.id] = it;

  const ordered =
    opts.shuffleAtStart && items.length > 1
      ? shuffledCopy(items, opts.random)
      : items;
  const queue = ordered.map((it) => [it.id]);
  const progress = freshMergeProgress(queue);
  advance(progress, new Set(), opts);
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(
    progress,
    new Set(),
    opts,
  );
  return { ...progress, items: itemsDict };
}

/**
 * Merge-pre-ranked-lists entry point. Extras (unranked) go to the FRONT of
 * the queue as singletons; pre-ranked sublists follow.
 */
export function seedFromSublists(
  args: {
    sublists: Item[][];
    extras: Item[];
  },
  options?: MergeOptions,
): MergeState {
  const { sublists, extras } = args;
  const opts = resolveOptions(options);
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of extras) itemsDict[it.id] = it;
  for (const sub of sublists) for (const it of sub) itemsDict[it.id] = it;

  const queue: ItemId[][] = [];
  const orderedExtras =
    opts.shuffleAtStart && extras.length > 1
      ? shuffledCopy(extras, opts.random)
      : extras;
  for (const it of orderedExtras) queue.push([it.id]);
  for (const sub of sublists) queue.push(sub.map((it) => it.id));

  const progress = freshMergeProgress(queue);
  advance(progress, new Set(), opts);
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(
    progress,
    new Set(),
    opts,
  );
  return { ...progress, items: itemsDict };
}

function bumpTotalComparisons(
  progress: MergeProgress,
  opts: Required<MergeOptions>,
): void {
  const current = comparisonsRemainingFromProgress(
    progress,
    new Set(progress.hidden),
    opts,
  );
  if (current > progress.totalComparisonsEverNeeded) {
    progress.totalComparisonsEverNeeded = current;
  }
}

/**
 * When minting a new slot from a completed merge, comparison stats should
 * count only work in that slot — not inherit the parent's tally.
 */
export function resetBranchedComparisonProgress(
  state: MergeState,
  options?: MergeOptions,
): MergeState {
  const opts = resolveOptions(options);
  const progress = snapshotProgress(state);
  progress.comparisons = 0;
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(
    progress,
    new Set(progress.hidden),
    opts,
  );
  return restoreProgress(state, progress);
}

/**
 * Pick the visible head of `left` or `right`. Three-stage dispatch:
 *  - when a manual-insert frame is active (user-triggered), route to
 *    the binary-insert path with cancel semantics.
 *  - when an auto-insert frame is active (engine-triggered), route to
 *    the auto-insert path (frame advances or splices into the popped
 *    target sublist).
 *  - otherwise route to the merge-frame path (today's behavior).
 *
 * Returns a brand-new MergeState.
 */
function applyPick(
  state: MergeState,
  side: 'left' | 'right',
  opts: Required<MergeOptions>,
): MergeState {
  if (state.currentManualInsert) {
    return applyManualInsertPick(state, side, opts);
  }
  if (state.currentAutoInsert && state.currentAutoInsert.frame) {
    return applyAutoInsertPick(state, side, opts);
  }
  return applyMergePick(state, side, opts);
}

function applyMergePick(
  state: MergeState,
  side: 'left' | 'right',
  opts: Required<MergeOptions>,
): MergeState {
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
  flushIfMergeComplete(next, hidden, opts);
  bumpTotalComparisons(next, opts);
  return { ...next, items: state.items };
}

function applyManualInsertPick(
  state: MergeState,
  side: 'left' | 'right',
  opts: Required<MergeOptions>,
): MergeState {
  if (!state.currentManualInsert) return state;
  const hidden = new Set(state.hidden);
  const next = snapshotProgress(state);
  const mi = next.currentManualInsert!;
  // Convention pinned by getInsertPair: leftId = insertingId, rightId
  // = sorted[probe]. So picking left = 'inserting', picking right = 'sorted'.
  const picked = side === 'left' ? 'inserting' : 'sorted';
  const res = applyInsertPick(mi.frame, picked);
  next.comparisons += 1;
  if ('done' in res) {
    const sub = next.queue[mi.targetQueueIndex];
    if (sub) {
      next.queue[mi.targetQueueIndex] = [
        ...sub.slice(0, res.position),
        mi.insertingId,
        ...sub.slice(res.position),
      ];
    }
    next.toBeInserted = next.toBeInserted.filter((x) => x !== mi.insertingId);
    next.currentManualInsert = null;
    drainManualInserts(next, hidden);
    if (!next.currentManualInsert) advance(next, hidden, opts);
  } else {
    mi.frame = res;
  }
  bumpTotalComparisons(next, opts);
  return { ...next, items: state.items };
}

/**
 * Auto-insert pick handler. Splices the inserting id into `ai.target` at
 * the resolved position when the frame collapses, then drains the next
 * pending insert. When `pendingInserts` is empty too, drainAutoInsert
 * pushes the grown target back to the queue and calls advance() (which
 * may install another auto-insert / merge frame).
 */
function applyAutoInsertPick(
  state: MergeState,
  side: 'left' | 'right',
  opts: Required<MergeOptions>,
): MergeState {
  if (!state.currentAutoInsert || !state.currentAutoInsert.frame) return state;
  const hidden = new Set(state.hidden);
  const next = snapshotProgress(state);
  const ai = next.currentAutoInsert!;
  const picked = side === 'left' ? 'inserting' : 'sorted';
  const res = applyInsertPick(ai.frame!, picked);
  next.comparisons += 1;
  if ('done' in res) {
    // Splice the inserting id into target at the resolved position.
    const insertingId = ai.frame!.insertingId;
    ai.target = [
      ...ai.target.slice(0, res.position),
      insertingId,
      ...ai.target.slice(res.position),
    ];
    ai.lastInsertedPosition = res.position;
    ai.frame = null;
    drainAutoInsert(next, hidden, opts);
  } else {
    ai.frame = res;
  }
  bumpTotalComparisons(next, opts);
  return { ...next, items: state.items };
}

/**
 * Drain the auto-insert frame's pendingInserts onto `ai.frame`. Picks
 * the rank-aware lower bound (`lastInsertedPosition + 1`) so each
 * subsequent insert only searches the suffix of `target` that hasn't
 * been bounded out yet — this is "Option B" rank-aware tightening from
 * the plan, valid because pendingInserts is FIFO in rank order.
 *
 * When pendingInserts is empty AND frame is null, the auto-insert is
 * done: push `ai.target` back onto the queue and clear
 * `currentAutoInsert`, then advance() (which may install the next
 * auto-insert or merge frame).
 *
 * No-op when there's no current auto-insert frame.
 */
function drainAutoInsert(
  progress: MergeProgress,
  hidden: ReadonlySet<ItemId>,
  opts: Required<MergeOptions>,
): void {
  const ai = progress.currentAutoInsert;
  if (!ai) return;
  while (ai.frame === null && ai.pendingInserts.length > 0) {
    const id = ai.pendingInserts[0];
    // Rank-aware lower bound via the shared helper (anchor =
    // lastInsertedPosition). Valid because pendingInserts is FIFO in
    // rank order — see startRankAwareInsert / drainPending.
    const res = startRankAwareInsert(ai.target, id, ai.lastInsertedPosition);
    ai.pendingInserts.shift();
    if ('done' in res) {
      ai.target = [
        ...ai.target.slice(0, res.position),
        id,
        ...ai.target.slice(res.position),
      ];
      ai.lastInsertedPosition = res.position;
      continue;
    }
    ai.frame = res;
    return;
  }
  if (ai.frame === null && ai.pendingInserts.length === 0) {
    // All items landed — push the grown target back to the queue.
    // Any ids hidden mid-auto-insert (probe-skipped target items) are
    // exiled to `toBeInserted` rather than riding along into the merged
    // sublist, mirroring the merge-close exile rule. Otherwise hidden
    // items would land at arbitrary positions in the closed sublist.
    exileAndPush(progress, ai.target, hidden);
    progress.currentAutoInsert = null;
    advance(progress, hidden, opts);
  }
}

export function pickLeft(
  state: MergeState,
  options?: MergeOptions,
): MergeState {
  return applyPick(state, 'left', resolveOptions(options));
}
export function pickRight(
  state: MergeState,
  options?: MergeOptions,
): MergeState {
  return applyPick(state, 'right', resolveOptions(options));
}

/**
 * Hide an item (remove from contention). Reversible via undo. If hiding
 * empties one side of the current merge, the merge auto-closes — and
 * the hidden item(s) get exiled into `toBeInserted` (see exile rule above).
 *
 * Hiding the currently-inserting manual-insert item cancels its frame
 * and removes the id from `toBeInserted` (hiding signals "I don't want it
 * at all" — distinct from cancelling, which leaves the id Insert-able
 * again).
 *
 * Hiding an id during an auto-insert is handled in three sub-cases:
 *  - id is the auto-insert frame's currently-inserting id → cancel
 *    that frame (skip it) and continue with the rest of pendingInserts;
 *  - id is somewhere in pendingInserts → remove it from the list;
 *  - id is in the popped `target` array → no-op (probe-skipping at
 *    pick time handles it the same way as it does for sorted[] in
 *    insertion mode).
 */
export function hideItem(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (!state.items[id]) return state;
  if (state.hidden.includes(id)) return state;
  const opts = resolveOptions(options);

  const next = snapshotProgress(state);
  next.hidden = [...next.hidden, id].sort();
  // Cancel a manual-insert frame on this id.
  if (next.currentManualInsert && next.currentManualInsert.insertingId === id) {
    next.currentManualInsert = null;
  }
  // Auto-insert: cancel the current insert if it's on this id, OR drop
  // the id from pendingInserts. Target items handled by probe-skip.
  if (next.currentAutoInsert) {
    const ai = next.currentAutoInsert;
    if (ai.frame && ai.frame.insertingId === id) {
      ai.frame = null;
    }
    ai.pendingInserts = ai.pendingInserts.filter((x) => x !== id);
    const hiddenSet = new Set(next.hidden);
    drainAutoInsert(next, hiddenSet, opts);
  }
  next.toBeInserted = next.toBeInserted.filter((x) => x !== id);
  next.pendingManualInserts = next.pendingManualInserts.filter((x) => x !== id);
  const hiddenSet = new Set(next.hidden);
  flushIfMergeComplete(next, hiddenSet, opts);
  // Re-check done in case hiding completed the last merge.
  if (
    next.queue.length <= 1 &&
    next.current === null &&
    next.currentManualInsert === null &&
    next.currentAutoInsert === null &&
    next.pendingManualInserts.length === 0
  ) {
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
 *
 * Important: unhide does NOT touch the `toBeInserted` bucket. Items in
 * `toBeInserted` are not in `state.hidden`; the user explicitly inserts
 * them via `manualInsert` instead.
 */
export function unhideItem(state: MergeState, id: ItemId): MergeState {
  if (!state.hidden.includes(id)) return state;

  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

/** Drop an id from `hidden[]` without changing the ranking. */
export function dismissHidden(state: MergeState, id: ItemId): MergeState {
  if (!state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

/**
 * Permanently drop a hidden id from the sort: clear `hidden[]` and remove
 * it from queue sublists, `toBeInserted`, in-flight merge/insert frames.
 * Keeps the `items` entry. Orphans only clear the hidden bit.
 */
export function forgetHiddenItem(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (!state.hidden.includes(id)) return state;
  const opts = resolveOptions(options);
  const inRanking =
    state.queue.some((sub) => sub.includes(id)) ||
    state.toBeInserted.includes(id) ||
    (state.current !== null &&
      (state.current.left.includes(id) ||
        state.current.right.includes(id) ||
        state.current.merged.includes(id)));
  if (!inRanking) return dismissHidden(state, id);

  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  next.queue = next.queue
    .map((sub) => sub.filter((x) => x !== id))
    .filter((sub) => sub.length > 0);
  next.toBeInserted = next.toBeInserted.filter((x) => x !== id);
  next.pendingManualInserts = next.pendingManualInserts.filter((x) => x !== id);

  if (next.current) {
    next.current = {
      left: next.current.left.filter((x) => x !== id),
      right: next.current.right.filter((x) => x !== id),
      merged: next.current.merged.filter((x) => x !== id),
    };
  }
  if (next.currentManualInsert?.insertingId === id) {
    next.currentManualInsert = null;
  }
  if (next.currentAutoInsert) {
    const ai = next.currentAutoInsert;
    if (ai.frame?.insertingId === id) ai.frame = null;
    ai.pendingInserts = ai.pendingInserts.filter((x) => x !== id);
    ai.target = ai.target.filter((x) => x !== id);
  }

  const hiddenSet = new Set(next.hidden);
  if (next.current) flushIfMergeComplete(next, hiddenSet, opts);
  drainManualInserts(next, hiddenSet);
  if (
    !next.currentManualInsert &&
    next.current === null &&
    next.currentAutoInsert === null
  ) {
    advance(next, hiddenSet, opts);
  }
  if (
    next.queue.length <= 1 &&
    next.current === null &&
    next.currentManualInsert === null &&
    next.currentAutoInsert === null &&
    next.pendingManualInserts.length === 0
  ) {
    next.done = true;
  }
  return { ...next, items: state.items };
}

/**
 * Restore a hidden merge item that is not in any queue sublist or
 * `toBeInserted`. When metadata exists, queues it for manual insert.
 */
export function restoreHiddenItem(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (!state.hidden.includes(id)) return state;
  if (!state.items[id]) return dismissHidden(state, id);

  const inQueue = state.queue.some((sub) => sub.includes(id));
  if (inQueue || state.toBeInserted.includes(id)) {
    return unhideItem(state, id);
  }

  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  if (!next.toBeInserted.includes(id)) {
    next.toBeInserted.push(id);
  }
  const withItems: MergeState = { ...next, items: state.items };
  return manualInsert(withItems, id, options);
}

/**
 * Queue an id from the `toBeInserted` bucket for the binary-insertion drain — user-triggered
 * "I want this item put back into the ranking." Drains immediately if
 * no merge is in flight, otherwise waits for `flushIfMergeComplete`.
 * The item must be in `state.toBeInserted`.
 */
/**
 * Pull an id out of a queue sublist and binary-search it back in via the
 * manual-insert drain — same UX as insertion-engine `returnToPending` (↻).
 * The id is removed from `queue`, placed in `toBeInserted`, then drained.
 */
export function returnToPending(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (state.hidden.includes(id)) return state;

  let queueIndex = -1;
  for (let qi = 0; qi < state.queue.length; qi++) {
    if (state.queue[qi].includes(id)) {
      queueIndex = qi;
      break;
    }
  }
  if (queueIndex < 0) return state;

  const progress = snapshotProgress(state);
  const sub = progress.queue[queueIndex].filter((x) => x !== id);
  if (sub.length === 0) {
    progress.queue = progress.queue.filter((_, i) => i !== queueIndex);
  } else {
    progress.queue[queueIndex] = sub;
  }
  if (!progress.toBeInserted.includes(id)) {
    progress.toBeInserted.push(id);
  }
  const withItems: MergeState = { ...progress, items: state.items };
  return manualInsert(withItems, id, options);
}

export function manualInsert(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (!state.toBeInserted.includes(id)) return state;
  if (state.pendingManualInserts.includes(id)) return state;
  const opts = resolveOptions(options);

  const next = snapshotProgress(state);
  next.pendingManualInserts.push(id);
  if (next.done) next.done = false;
  // If nothing is in flight, drain right now.
  if (
    next.current === null &&
    next.currentManualInsert === null &&
    next.currentAutoInsert === null
  ) {
    const hidden = new Set(next.hidden);
    drainManualInserts(next, hidden);
    if (!next.currentManualInsert) advance(next, hidden, opts);
  }
  bumpTotalComparisons(next, opts);
  return { ...next, items: state.items };
}

/**
 * Permanently drop a to-be-inserted id from the rank. Used by the "Forget"
 * affordance — the item still exists in `state.items` (so the id is
 * meaningful for UI labels), but it doesn't appear in any ranking.
 */
export function forgetItem(
  state: MergeState,
  id: ItemId,
  options?: MergeOptions,
): MergeState {
  if (!state.toBeInserted.includes(id)) return state;
  const opts = resolveOptions(options);
  const next = snapshotProgress(state);
  next.toBeInserted = next.toBeInserted.filter((x) => x !== id);
  next.pendingManualInserts = next.pendingManualInserts.filter((x) => x !== id);
  // If a manual insert was about to start for this id (drained but not
  // yet resolved), cancel it.
  if (next.currentManualInsert && next.currentManualInsert.insertingId === id) {
    next.currentManualInsert = null;
    const hidden = new Set(next.hidden);
    drainManualInserts(next, hidden);
    if (!next.currentManualInsert) advance(next, hidden, opts);
  }
  // Re-check done.
  if (
    next.queue.length <= 1 &&
    next.current === null &&
    next.currentManualInsert === null &&
    next.currentAutoInsert === null &&
    next.pendingManualInserts.length === 0
  ) {
    next.done = true;
  }
  return { ...next, items: state.items };
}

/**
 * Cancel the currently-running manual insert, bouncing the inserting
 * item back into `toBeInserted` and clearing `currentManualInsert`. The
 * user can either Forget it from there or click Insert again later.
 *
 * Doesn't unwind the comparisons already made for this insert — they
 * "count" as work done; the undo ring is the way to back them out.
 *
 * Note: there is no public cancel-auto-insert API. Auto-insert is
 * engine-driven and runs to completion; the user can only intervene
 * by hiding individual ids (which is handled in hideItem above).
 */
export function cancelManualInsert(
  state: MergeState,
  options?: MergeOptions,
): MergeState {
  if (!state.currentManualInsert) return state;
  const opts = resolveOptions(options);
  const next = snapshotProgress(state);
  // insertingId is still in `toBeInserted` (we only remove on resolve, not
  // on drain). No bouncing needed; just clear the frame.
  next.currentManualInsert = null;
  // Drain the next pending manual insert, if any; otherwise advance.
  const hidden = new Set(next.hidden);
  drainManualInserts(next, hidden);
  if (!next.currentManualInsert) advance(next, hidden, opts);
  return { ...next, items: state.items };
}

/**
 * Add a brand-new item mid-sort (or after `done`). Pushes a singleton to the
 * back of the queue. If currently done, flips back to not-done and advances.
 * Refuses if an item with this canonical key already exists (caller
 * should detect and surface a friendly message).
 */
export function addItem(
  state: MergeState,
  item: Item,
  options?: MergeOptions,
): MergeState | null {
  if (state.items[item.id]) return null;
  const opts = resolveOptions(options);

  const next = snapshotProgress(state);
  next.queue.push([item.id]);
  if (next.done) {
    next.done = false;
  }
  advance(next, new Set(next.hidden), opts);
  bumpTotalComparisons(next, opts);

  return {
    ...next,
    items: { ...state.items, [item.id]: item },
  };
}

/**
 * Batch-add items as N individual singleton sublists, appended to the
 * back of the queue. Equivalent to calling `addItem(item)` for each item
 * (preserving input order) but does the snapshot + advance + total-bump
 * once instead of N times.
 *
 * Use this when the user provides a list of unranked items via the
 * "Multiple" tab of the LIST tab's add-items modal. For lists that
 * carry their own ranking, use `appendPreRankedSublist` instead.
 *
 * Dedup contract: items whose id is already present in `state.items`
 * are skipped (returned in `skipped`); their URL/IMAGE metadata is
 * merged into the existing record if the existing record lacks the
 * field (same first-occurrence-wins rule as `appendPreRankedSublist`).
 */
export function addItems(
  state: MergeState,
  items: Item[],
  options?: MergeOptions,
): { state: MergeState; skipped: ItemId[] } {
  const opts = resolveOptions(options);
  const itemsDict = { ...state.items };
  const skipped: ItemId[] = [];
  const newSingletonIds: ItemId[] = [];

  for (const it of items) {
    const existing = itemsDict[it.id];
    if (existing) {
      skipped.push(it.id);
      itemsDict[it.id] = {
        ...existing,
        url: existing.url ?? it.url,
        imageUrl: existing.imageUrl ?? it.imageUrl,
      };
      continue;
    }
    itemsDict[it.id] = it;
    newSingletonIds.push(it.id);
  }

  if (newSingletonIds.length === 0) {
    return { state: { ...state, items: itemsDict }, skipped };
  }

  const next = snapshotProgress(state);
  for (const id of newSingletonIds) next.queue.push([id]);
  if (next.done) next.done = false;
  advance(next, new Set(next.hidden), opts);
  bumpTotalComparisons(next, opts);

  return {
    state: { ...next, items: itemsDict },
    skipped,
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
  state: MergeState,
  items: Item[],
  options?: MergeOptions,
): { state: MergeState; skipped: ItemId[] } {
  const opts = resolveOptions(options);
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
    advance(next, new Set(next.hidden), opts);
    bumpTotalComparisons(next, opts);
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
  state: MergeState,
  queueIndex: number,
  itemIndex: number,
  direction: -1 | 1,
): MergeState {
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

/** Which slice of the in-flight merge frame to reorder within. */
export type CurrentMergeSlice = 'merged' | 'left' | 'right';

function currentMergeSliceArray(
  frame: { left: ItemId[]; right: ItemId[]; merged: ItemId[] },
  slice: CurrentMergeSlice,
): ItemId[] {
  if (slice === 'merged') return frame.merged;
  if (slice === 'left') return frame.left;
  return frame.right;
}

/**
 * Whether an adjacent swap is allowed within one slice of the active merge
 * frame (bounds and slice presence only). Reordering the visible compare
 * head is allowed — LIST shows the slice being edited; RANK picks up the
 * new pair when the user returns (CompareScreen remounts on tab switch).
 */
export function canReorderInCurrentMerge(
  state: MergeState,
  slice: CurrentMergeSlice,
  itemIndex: number,
  direction: -1 | 1,
): boolean {
  if (!state.current) return false;
  const arr = currentMergeSliceArray(state.current, slice);
  const target = itemIndex + direction;
  if (itemIndex < 0 || itemIndex >= arr.length) return false;
  if (target < 0 || target >= arr.length) return false;
  return arr.length > 1;
}

/**
 * Move an item up or down within one slice of the in-flight merge frame
 * (`merged`, `left`, or `right`). Swaps never cross slice boundaries.
 */
export function reorderInCurrentMerge(
  state: MergeState,
  slice: CurrentMergeSlice,
  itemIndex: number,
  direction: -1 | 1,
): MergeState {
  if (!canReorderInCurrentMerge(state, slice, itemIndex, direction)) {
    return state;
  }

  const next = snapshotProgress(state);
  const frame = next.current!;
  const arr = currentMergeSliceArray(frame, slice).slice();
  const target = itemIndex + direction;
  [arr[itemIndex], arr[target]] = [arr[target], arr[itemIndex]];
  if (slice === 'merged') frame.merged = arr;
  else if (slice === 'left') frame.left = arr;
  else frame.right = arr;
  return { ...next, items: state.items };
}

/**
 * Destroy a sublist: pop it out of its queue position and push each of its
 * ids back as a singleton sublist at the END of the queue. Equivalent to
 * "I want these all re-sorted from scratch." No-op for single-item sublists.
 */
export function breakApartSublist(
  state: MergeState,
  queueIndex: number,
  options?: MergeOptions,
): MergeState {
  if (queueIndex < 0 || queueIndex >= state.queue.length) return state;
  const sub = state.queue[queueIndex];
  if (sub.length <= 1) return state;
  const opts = resolveOptions(options);

  const next = snapshotProgress(state);
  next.queue.splice(queueIndex, 1);
  for (const id of sub) next.queue.push([id]);
  if (next.done && next.queue.length > 1) {
    next.done = false;
  }
  advance(next, new Set(next.hidden), opts);
  bumpTotalComparisons(next, opts);
  return { ...next, items: state.items };
}

/**
 * Re-export the manual-insert and auto-insert frame types for storage
 * / tests that need them.
 */
export type { AutoInsertFrame, ManualInsertFrame };
