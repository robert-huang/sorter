import {
  applyInsertPick,
  getInsertPair as getInsertPairPrimitive,
  countInsertPeekRightOverflow,
  getInsertPeekRightIds,
  insertComparisonsRemaining,
  startRankAwareInsert,
  worstCaseInsertCost,
} from './binaryInsertion';
import { shuffledCopy } from './shuffle';
import type {
  InsertFrame,
  InsertionProgress,
  InsertionState,
  Item,
  ItemId,
} from './types';

/**
 * Smallest run id not already used by `pending` / the active run. Used
 * when re-queuing an item as its own singleton run (cancel-and-restart,
 * return-to-pending, add-item) so it gets a full-range insert and never
 * accidentally shares a run with an unrelated item.
 *
 * Only meaningful when `pendingRunIds` is present (the pre-ranked path).
 * The flat / add-items paths leave `pendingRunIds` undefined entirely.
 */
function freshRunId(progress: InsertionProgress): number {
  let max = -1;
  if (progress.pendingRunIds) {
    for (const r of progress.pendingRunIds) if (r > max) max = r;
  }
  if (typeof progress.activeRunId === 'number' && progress.activeRunId > max) {
    max = progress.activeRunId;
  }
  return max + 1;
}

// ---------- helpers ----------

/**
 * Find the next probe index in `sorted` that is not hidden, starting
 * from `frame.probe` and moving in the implied direction. Used so that
 * picks against a hidden probe item are skipped silently rather than
 * shown to the user.
 *
 * Returns either a new frame whose probe is on a visible item, or
 * `{ done; position }` if all probes in [lo, hi] are hidden.
 */
function skipHiddenProbes(
  frame: InsertFrame,
  sorted: ReadonlyArray<ItemId>,
  hidden: ReadonlySet<ItemId>,
): InsertFrame | { done: true; position: number } {
  let cur: InsertFrame = frame;
  let safety = sorted.length + 2;
  while (safety-- > 0) {
    if (!hidden.has(sorted[cur.probe])) return cur;
    // Hidden probe: pretend the user picked 'sorted' (probe is below
    // insertingId) — i.e. skip past it on the lower side. Either side
    // is fine semantically since the hidden item has no opinion; we
    // pick a deterministic direction so behaviour is reproducible.
    const r = applyInsertPick(cur, 'sorted');
    if ('done' in r) return r;
    cur = r;
  }
  return { done: true, position: cur.lo };
}

/**
 * Public helper: returns the pair of visible ids currently being
 * compared, or null when there is no active insert frame (or no visible
 * probe exists in [lo, hi]).
 */
export function getPair(
  state: InsertionState,
): { leftId: ItemId; rightId: ItemId } | null {
  if (!state.current) return null;
  const hidden = new Set(state.hidden);
  if (hidden.has(state.current.insertingId)) return null;
  const skipped = skipHiddenProbes(state.current, state.sorted, hidden);
  if ('done' in skipped) return null;
  return getInsertPairPrimitive(skipped, state.sorted);
}

/**
 * Up to `n` rank-adjacent visible ids in `sorted` immediately after the
 * current probe (the right card in the compare UI). Drives the peek
 * deck rendered behind B. Returns [] when there's no current frame or
 * all probes in the active range are hidden.
 */
export function getPeekRightIds(state: InsertionState, n = 3): ItemId[] {
  if (!state.current) return [];
  const hidden = new Set(state.hidden);
  if (hidden.has(state.current.insertingId)) return [];
  const skipped = skipHiddenProbes(state.current, state.sorted, hidden);
  if ('done' in skipped) return [];
  return getInsertPeekRightIds(skipped, state.sorted, hidden, n);
}

/**
 * Insertion engine: the left card is the single inserting item, which
 * has no rank-adjacent neighbor. Always [] — CompareScreen uses this
 * to skip rendering a left-side peek deck in insert modes.
 */
export function getPeekLeftIds(_state: InsertionState, _n = 3): ItemId[] {
  return [];
}

export function getPeekRightOverflowCount(
  state: InsertionState,
  labeledDepth: number,
): number {
  if (!state.current) return 0;
  const hidden = new Set(state.hidden);
  if (hidden.has(state.current.insertingId)) return 0;
  const skipped = skipHiddenProbes(state.current, state.sorted, hidden);
  if ('done' in skipped) return 0;
  return countInsertPeekRightOverflow(
    skipped,
    state.sorted,
    hidden,
    labeledDepth,
  );
}

export function getPeekLeftOverflowCount(
  _state: InsertionState,
  _labeledDepth: number,
): number {
  return 0;
}

/**
 * Worst-case comparisons remaining for the entire plan: the current
 * frame's remaining probes plus the per-item cost of every item still
 * waiting in `pending`. Matches the merge engine's monotonic invariant
 * (never undercounts, may overcount).
 */
export function comparisonsRemaining(state: InsertionState): number {
  if (state.done) return 0;
  return comparisonsRemainingFromProgress(state);
}

function comparisonsRemainingFromProgress(
  progress: InsertionProgress,
): number {
  if (progress.done) return 0;
  let total = 0;
  let sortedLen = progress.sorted.length;
  if (progress.current) {
    total += insertComparisonsRemaining(progress.current);
    // After current resolves, sorted grows by 1.
    sortedLen += 1;
  }
  for (let i = 0; i < progress.pending.length; i++) {
    total += worstCaseInsertCost(sortedLen);
    sortedLen += 1;
  }
  return total;
}

/** Final ranking when done. Filters out hidden ids. */
export function getRanking(state: InsertionState): ItemId[] {
  if (!state.done) return [];
  const hidden = new Set(state.hidden);
  return state.sorted.filter((id) => !hidden.has(id));
}

// ---------- snapshot ----------

export function snapshotProgress(state: InsertionState): InsertionProgress {
  return {
    engine: 'insertion',
    sorted: state.sorted.slice(),
    pending: state.pending.slice(),
    current: state.current
      ? {
          insertingId: state.current.insertingId,
          lo: state.current.lo,
          hi: state.current.hi,
          probe: state.current.probe,
        }
      : null,
    comparisons: state.comparisons,
    done: state.done,
    hidden: state.hidden.slice(),
    totalComparisonsEverNeeded: state.totalComparisonsEverNeeded,
    pendingRunIds: state.pendingRunIds ? state.pendingRunIds.slice() : undefined,
    activeRunId: state.activeRunId ?? null,
    activeRunAnchor: state.activeRunAnchor ?? null,
  };
}

export function restoreProgress(
  state: InsertionState,
  progress: InsertionProgress,
): InsertionState {
  return {
    ...progress,
    sorted: progress.sorted.slice(),
    pending: progress.pending.slice(),
    current: progress.current
      ? {
          insertingId: progress.current.insertingId,
          lo: progress.current.lo,
          hi: progress.current.hi,
          probe: progress.current.probe,
        }
      : null,
    hidden: progress.hidden.slice(),
    pendingRunIds: progress.pendingRunIds
      ? progress.pendingRunIds.slice()
      : undefined,
    items: state.items,
  };
}

// ---------- internal: drain pending into current ----------

/**
 * If `current` is null and `pending` has items, install a frame for the
 * next pending. May terminate immediately (single-item sorted with a
 * collapsed range) — in which case we splice and re-drain, until either
 * a real frame is installed or pending is empty.
 *
 * Rank-aware tightening: when the next pending item continues the active
 * ranked run (`pendingRunIds[0] === activeRunId`), its binary search
 * starts at `activeRunAnchor + 1` — the suffix after the previous
 * same-run item landed — via the shared `startRankAwareInsert` helper.
 * This is the same `lastInsertedPosition + 1` trick the merge engine's
 * `drainAutoInsert` uses. When the run id changes (or there's no run
 * info), the anchor resets and the item searches the full range.
 *
 * Mutates the passed progress in place; caller owns the undo snapshot.
 */
function drainPending(progress: InsertionProgress): void {
  // Convention (matches merge engine's queue → current): when we install
  // a frame, the id is POPPED from pending — it's now "in flight", not
  // "waiting". Splicing the resolved id back into sorted is handled by
  // spliceInsertingAndDrain. This means `pending` always lists items
  // strictly behind `current` in the FIFO order.
  while (progress.current === null && progress.pending.length > 0) {
    const id = progress.pending[0];
    const runId = progress.pendingRunIds ? progress.pendingRunIds[0] : undefined;
    // New run (or no run info) ⇒ drop the anchor so this item searches
    // the full range. Same run ⇒ keep the anchor for tightening.
    const continuesRun = runId !== undefined && runId === progress.activeRunId;
    if (!continuesRun) {
      progress.activeRunId = runId ?? null;
      progress.activeRunAnchor = null;
    }
    const res = startRankAwareInsert(
      progress.sorted,
      id,
      progress.activeRunAnchor ?? null,
    );
    progress.pending.shift();
    if (progress.pendingRunIds) progress.pendingRunIds.shift();
    if ('done' in res) {
      // Zero-comparison case (e.g., first insert into an empty sorted,
      // or a fully bounded run step). Record the landing as the new
      // anchor so the next same-run item tightens against it.
      progress.sorted = [
        ...progress.sorted.slice(0, res.position),
        id,
        ...progress.sorted.slice(res.position),
      ];
      progress.activeRunAnchor = res.position;
      continue;
    }
    // Real frame: the in-flight item's run is `activeRunId` (already set
    // above). `activeRunAnchor` keeps the PREVIOUS item's position (it
    // produced this item's lo); it's overwritten with this item's
    // landing position when the frame resolves in spliceInsertingAndDrain.
    progress.current = res;
    return;
  }
  if (progress.current === null && progress.pending.length === 0) {
    progress.done = true;
  }
}

// ---------- public transitions ----------

/**
 * Build an InsertionState from a frozen sorted-list seed + new items to
 * insert. Used by the CSV-as-sorted START entry point (with empty
 * `pending` and done=true) and by the merge→insertion engine transition
 * (with the merge's final ranking as `sorted` and the new items as
 * `pending`).
 *
 * Items in `pending` that match an id already in `sortedItems` are
 * skipped (returned in `skipped`) — matches the dedup contract of the
 * other entry points.
 */
export function buildInsertionState(args: {
  sortedItems: Item[];
  pendingItems: Item[];
  hidden?: ItemId[];
  /**
   * OPTIONAL run partition aligned to `pendingItems` (same length): equal
   * consecutive values mark a pre-ranked run eligible for bound
   * tightening (see `seedInsertionFromSublists`). Entries for items
   * skipped by dedup are dropped so the stored array stays parallel to
   * the surviving `pending`. Omit for flat / unranked inserts.
   */
  pendingRunIds?: number[];
}): { state: InsertionState; skipped: ItemId[] } {
  const { sortedItems, pendingItems, hidden = [], pendingRunIds } = args;
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of sortedItems) itemsDict[it.id] = it;
  const skipped: ItemId[] = [];
  const survivingPending: Item[] = [];
  const survivingRunIds: number[] = [];
  for (let i = 0; i < pendingItems.length; i++) {
    const it = pendingItems[i];
    if (itemsDict[it.id]) {
      skipped.push(it.id);
      continue;
    }
    itemsDict[it.id] = it;
    survivingPending.push(it);
    if (pendingRunIds) survivingRunIds.push(pendingRunIds[i]);
  }
  const sorted = sortedItems.map((it) => it.id);
  const pending = survivingPending.map((it) => it.id);
  const progress: InsertionProgress = {
    engine: 'insertion',
    sorted,
    pending,
    current: null,
    comparisons: 0,
    done: false,
    hidden: hidden.slice(),
    totalComparisonsEverNeeded: 0,
    pendingRunIds: pendingRunIds ? survivingRunIds : undefined,
    activeRunId: null,
    activeRunAnchor: null,
  };
  drainPending(progress);
  // Set the initial worst-case budget AFTER draining so zero-comparison
  // splices (empty sorted → first insert is free) are already accounted
  // for in the count. Matches initSort's pattern in queueMergeSort.ts.
  progress.totalComparisonsEverNeeded = comparisonsRemainingFromProgress(progress);
  return { state: { ...progress, items: itemsDict }, skipped };
}

/** Convenience: seed a completed insertion-mode slot from a pre-sorted list. */
export function seedAsSorted(items: Item[]): InsertionState {
  const { state } = buildInsertionState({
    sortedItems: items,
    pendingItems: [],
  });
  return state;
}

/**
 * Options for the from-scratch / pre-ranked insertion-mode START entry
 * points. Mirrors the merge engine's `shuffleAtStart` knob.
 */
export interface InsertionSeedOptions {
  /**
   * Shuffle the unranked extras before queueing (default true) so paste
   * order doesn't dominate the first comparisons. Pre-ranked sublists
   * keep their asserted best→worst order (shuffling them would break the
   * rank assertion that makes bound tightening sound). Tests pass a
   * deterministic `random` and/or `shuffle: false`.
   */
  shuffle?: boolean;
  random?: () => number;
}

/**
 * START entry point: seed an insertion-mode sort from a mix of pre-ranked
 * sublists and unranked extras.
 *
 * The LARGEST pre-ranked sublist becomes the frozen `sorted[]` seed — it
 * reuses the most already-ordered work, so the fewest binary inserts
 * remain. The other sublists drain into `pending[]` as rank-aware RUNS
 * (each tightens its own search, item 2+ inserting only into the suffix
 * after the previous same-run item landed — see `drainPending` /
 * `startRankAwareInsert`). Extras drain as singleton runs (full-range).
 *
 * Run ids are only emitted when at least one non-seed sublist has 2+
 * items (otherwise every run is a singleton and tightening is moot — we
 * leave `pendingRunIds` undefined to keep the flat fast path).
 *
 * Dedup follows `buildInsertionState`: any pending id already in the seed
 * (or earlier in pending) is skipped and reported in `skipped`.
 */
export function seedInsertionFromSublists(
  args: { sublists: Item[][]; extras: Item[] },
  options?: InsertionSeedOptions,
): { state: InsertionState; skipped: ItemId[] } {
  const { sublists, extras } = args;
  const { shuffle = true, random } = options ?? {};

  // Largest sublist seeds the frozen list (first-wins on ties).
  let seedIdx = -1;
  let seedLen = 0;
  sublists.forEach((sub, i) => {
    if (sub.length > seedLen) {
      seedLen = sub.length;
      seedIdx = i;
    }
  });
  const seed = seedIdx >= 0 ? sublists[seedIdx] : [];
  const rest = sublists.filter((_, i) => i !== seedIdx);

  // Remaining sublists first (each a tightening run), then extras
  // (singleton runs). Run ids are dense integers; equal ids = one run.
  const pendingItems: Item[] = [];
  const runIds: number[] = [];
  let nextRun = 0;
  for (const sub of rest) {
    const rid = nextRun++;
    for (const it of sub) {
      pendingItems.push(it);
      runIds.push(rid);
    }
  }
  const orderedExtras =
    shuffle && extras.length > 1 ? shuffledCopy(extras, random) : extras;
  for (const it of orderedExtras) {
    pendingItems.push(it);
    runIds.push(nextRun++);
  }

  const hasMultiItemRun = rest.some((sub) => sub.length >= 2);
  return buildInsertionState({
    sortedItems: seed,
    pendingItems,
    pendingRunIds: hasMultiItemRun ? runIds : undefined,
  });
}

/**
 * START entry point: flat from-scratch insertion sort. Every item drains
 * full-range one-by-one (no runs). Thin wrapper over
 * `seedInsertionFromSublists` with everything as extras.
 */
export function initInsertionSort(
  items: Item[],
  options?: InsertionSeedOptions,
): InsertionState {
  const { state } = seedInsertionFromSublists(
    { sublists: [], extras: items },
    options,
  );
  return state;
}

/**
 * Pick the left card (= the inserting item) or the right card (= the
 * probed sorted item). Bumps comparisons + drains.
 */
function applyPick(
  state: InsertionState,
  side: 'left' | 'right',
): InsertionState {
  if (!state.current) return state;
  const hidden = new Set(state.hidden);
  if (hidden.has(state.current.insertingId)) return state;
  const visibleFrame = skipHiddenProbes(state.current, state.sorted, hidden);
  if ('done' in visibleFrame) {
    // All probes hidden — splice insertingId at the implied position
    // without charging a comparison; caller already saw no pair.
    return spliceInsertingAndDrain(state, visibleFrame.position);
  }
  const next = snapshotProgress(state);
  next.current = visibleFrame; // adopt the probe-skipped frame
  const picked = side === 'left' ? 'inserting' : 'sorted';
  const r = applyInsertPick(visibleFrame, picked);
  next.comparisons += 1;
  if ('done' in r) {
    return spliceInsertingAndDrain({ ...next, items: state.items }, r.position);
  }
  next.current = r;
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

/**
 * Splice the currently-inserting id into `sorted` at `position`,
 * clear `current`, drain to the next pending. Used both on normal
 * resolve and on the all-probes-hidden edge case.
 */
function spliceInsertingAndDrain(
  state: InsertionState,
  position: number,
): InsertionState {
  if (!state.current) return state;
  const next = snapshotProgress(state);
  const insertingId = next.current!.insertingId;
  next.sorted = [
    ...next.sorted.slice(0, position),
    insertingId,
    ...next.sorted.slice(position),
  ];
  // The in-flight item belonged to `activeRunId`; record where it landed
  // so the next same-run pending item tightens against it. (No-op for the
  // flat path where activeRunId is null and nothing continues the run.)
  next.activeRunAnchor = position;
  // No pending.shift here — drainPending already shifted when it
  // installed the frame; the inserting id lived only on `current`.
  next.current = null;
  drainPending(next);
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

export function pickLeft(state: InsertionState): InsertionState {
  return applyPick(state, 'left');
}
export function pickRight(state: InsertionState): InsertionState {
  return applyPick(state, 'right');
}

// ---------- freeze-relax mutations ----------

/**
 * Cancel any current binary-insertion frame and put its insertingId back
 * at the FRONT of `pending` (so it stays the next thing to insert), then
 * drain. Used by `reorderInSorted` / `returnToPending` after they mutate
 * `sorted[]` in a way that invalidates the frame's [lo, hi] bounds (which
 * reference now-stale indices into the OLD sorted array).
 *
 * Cost transparency: this throws away the comparisons already made in the
 * cancelled frame as far as the algorithm is concerned — they "happened"
 * (state.comparisons isn't decremented), but the new frame restarts from
 * full range. So the user pays up to ⌈log2(sorted.length + 1)⌉ extra
 * comparisons for the cancel-and-restart. Worth it because the
 * alternative (translating the partial bounds across an arbitrary sorted
 * mutation) is fragile and rarely correct.
 *
 * Mutates progress in place; caller owns the undo snapshot.
 */
function cancelAndRestartCurrentFrame(progress: InsertionProgress): void {
  if (progress.current === null) return;
  // Return the in-flight id to the FRONT of pending so drainPending
  // picks it up first when it installs the next frame.
  const id = progress.current.insertingId;
  progress.current = null;
  progress.pending = [id, ...progress.pending];
  // Re-queue it as its own singleton run and drop the active run anchor:
  // the caller mutated `sorted` (reorder), so any anchor positions are
  // stale. Full-range re-insert is the safe, correct fallback.
  if (progress.pendingRunIds) {
    progress.pendingRunIds = [freshRunId(progress), ...progress.pendingRunIds];
  }
  progress.activeRunId = null;
  progress.activeRunAnchor = null;
  drainPending(progress);
}

/**
 * Move an item up or down within `sorted[]`. direction: -1 = up (toward
 * index 0), +1 = down. No-op for out-of-range indices or when moving
 * off either end.
 *
 * If a current insertion frame is in flight, cancel-and-restart it (the
 * frame's bounds reference now-stale sorted indices). The undo ring
 * captures the snapshot before either the reorder or the restart so the
 * user can roll all of it back as a single step.
 */
export function reorderInSorted(
  state: InsertionState,
  sortedIndex: number,
  direction: -1 | 1,
): InsertionState {
  if (sortedIndex < 0 || sortedIndex >= state.sorted.length) return state;
  const target = sortedIndex + direction;
  if (target < 0 || target >= state.sorted.length) return state;

  const next = snapshotProgress(state);
  const newSorted = next.sorted.slice();
  [newSorted[sortedIndex], newSorted[target]] = [
    newSorted[target],
    newSorted[sortedIndex],
  ];
  next.sorted = newSorted;
  cancelAndRestartCurrentFrame(next);
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

/**
 * Move an item from `sorted[]` back to the FRONT of `pending[]`, so it
 * gets re-inserted via a fresh binary-insertion next. Useful when the
 * user realizes an item in the frozen ranking is in the wrong place and
 * wants to rebid it.
 *
 * If a current insertion frame is in flight, we cancel it (the frame's
 * bounds index into the OLD sorted array, which has just shrunk by one
 * — bounds are now stale). The in-flight id goes back to pending too,
 * but BEHIND the just-returned id so the returned id is what the user
 * sees next (matches their mental model of "I'm fixing this one right
 * now").
 *
 * Cost: the user pays up to ⌈log2(newSortedLen + 1)⌉ for the returned
 * item's re-insertion (plus any cancel-and-restart cost on the existing
 * frame). No-op if the id isn't in `sorted[]`.
 */
export function returnToPending(
  state: InsertionState,
  id: ItemId,
): InsertionState {
  const sortedIdx = state.sorted.indexOf(id);
  if (sortedIdx < 0) return state;
  const next = snapshotProgress(state);
  next.sorted = [
    ...next.sorted.slice(0, sortedIdx),
    ...next.sorted.slice(sortedIdx + 1),
  ];
  // Build the new pending in the correct visible order:
  //   [returned id, (in-flight id if any), ...originalPending]
  // The returned id MUST be at index 0 so drainPending installs its
  // frame first — that's what the user expects when they click ↻.
  const inFlightId = next.current ? next.current.insertingId : null;
  next.current = null;
  next.pending = inFlightId === null
    ? [id, ...next.pending]
    : [id, inFlightId, ...next.pending];
  // Re-queue the returned (and any in-flight) id as fresh singleton runs,
  // and drop the active anchor: removing an item from `sorted` shifts the
  // indices the anchor referenced, so a full-range re-insert is the safe
  // fallback. The returned item was never asserted pre-ranked anyway.
  if (next.pendingRunIds) {
    const base = freshRunId(next);
    next.pendingRunIds = inFlightId === null
      ? [base, ...next.pendingRunIds]
      : [base, base + 1, ...next.pendingRunIds];
  }
  next.activeRunId = null;
  next.activeRunAnchor = null;
  if (next.done) next.done = false;
  drainPending(next);
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

/**
 * When minting a new slot from a completed insertion sort, comparison stats
 * should count only work in that slot — not inherit the parent's tally.
 */
export function resetBranchedComparisonProgress(
  state: InsertionState,
): InsertionState {
  const progress = snapshotProgress(state);
  progress.comparisons = 0;
  progress.totalComparisonsEverNeeded =
    comparisonsRemainingFromProgress(progress);
  return restoreProgress(state, progress);
}

function bumpTotalComparisons(progress: InsertionProgress): void {
  // Convention shared with queueMergeSort.bumpTotalComparisons: the
  // field tracks the all-time-high of `remaining`. Bar position is
  // computed as (total - remaining) / total elsewhere, so as remaining
  // ticks down the bar fills.
  const current = comparisonsRemainingFromProgress(progress);
  if (current > progress.totalComparisonsEverNeeded) {
    progress.totalComparisonsEverNeeded = current;
  }
}

/**
 * Hide an item. Different semantics depending on where the id lives:
 *  - in pending → remove from pending (decrements total)
 *  - in sorted → mark hidden; probe-skipping handles it on the fly,
 *    UNLESS the active frame's [lo, hi] now contains zero visible
 *    probes — in that case there's nothing left to compare against, so
 *    we splice the inserting id at the resolved position and drain.
 *    Without this, getPair would return null while state.done is still
 *    false and the user would see a misleading "no comparison" state
 *    with no way forward except undo.
 *  - mid-insert (== current.insertingId) → cancel frame, drain next
 */
export function hideItem(
  state: InsertionState,
  id: ItemId,
): InsertionState {
  if (!state.items[id]) return state;
  if (state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = [...next.hidden, id].sort();
  // If the id was the currently-inserting item, cancel its frame and
  // drain the next pending. drainPending already shifted the id off
  // pending when it installed the frame, so we just drop `current`.
  if (next.current && next.current.insertingId === id) {
    next.current = null;
    drainPending(next);
  } else {
    // If it was a pending item (waiting), remove it (and its run id, kept
    // parallel). Dropping a waiting item never invalidates the active
    // anchor — `sorted` is untouched — so run tightening is preserved.
    const pi = next.pending.indexOf(id);
    if (pi >= 0) {
      next.pending.splice(pi, 1);
      if (next.pendingRunIds) next.pendingRunIds.splice(pi, 1);
      // pending-shrink might let us go done if nothing remains.
      if (next.current === null && next.pending.length === 0) {
        next.done = true;
      }
    }
    // Whether the hidden id was in pending or sorted, the active frame
    // may have just lost its last visible probe. Resolve the stalled
    // frame here (rather than leaving it for the UI to discover via a
    // null pair) by simulating the same splice-and-drain path that
    // applyPick takes when it encounters a collapsed visible range.
    if (next.current) {
      const hiddenSet = new Set(next.hidden);
      const skipped = skipHiddenProbes(next.current, next.sorted, hiddenSet);
      if ('done' in skipped) {
        const insertingId = next.current.insertingId;
        next.sorted = [
          ...next.sorted.slice(0, skipped.position),
          insertingId,
          ...next.sorted.slice(skipped.position),
        ];
        // The in-flight item just force-landed; anchor the active run to
        // it so a following same-run item still tightens correctly.
        next.activeRunAnchor = skipped.position;
        next.current = null;
        drainPending(next);
      }
    }
  }
  return { ...next, items: state.items };
}

/**
 * Unhide an item. If it was the active inserting item before the hide,
 * we don't restore the frame (we drained past it). The user can
 * re-add via addItem if they want to insert it after all.
 */
export function unhideItem(
  state: InsertionState,
  id: ItemId,
): InsertionState {
  if (!state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

/**
 * Drop an id from `hidden[]` without restoring it to the ranking. Clears
 * ghost entries whose metadata was already removed from `items`.
 */
export function dismissHidden(
  state: InsertionState,
  id: ItemId,
): InsertionState {
  if (!state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

/**
 * Restore a hidden item that no longer sits in `sorted[]` or `pending[]`
 * (typically removed from pending when hidden). Re-queues at the front of
 * `pending` for a fresh binary insert. In-ranking hidden ids delegate to
 * `unhideItem`.
 */
export function restoreHiddenItem(
  state: InsertionState,
  id: ItemId,
): InsertionState {
  if (!state.hidden.includes(id)) return state;
  if (!state.items[id]) return dismissHidden(state, id);
  if (state.sorted.includes(id) || state.pending.includes(id)) {
    return unhideItem(state, id);
  }
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  next.pending = [id, ...next.pending];
  if (next.pendingRunIds) {
    next.pendingRunIds = [freshRunId(next), ...next.pendingRunIds];
  }
  if (next.done) next.done = false;
  drainPending(next);
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

/**
 * Add a single new item to the back of `pending`. Returns null if the
 * id is already present (so caller can surface "skipped" feedback).
 */
export function addItem(
  state: InsertionState,
  item: Item,
): InsertionState | null {
  if (state.items[item.id]) return null;
  const next = snapshotProgress(state);
  next.pending = [...next.pending, item.id];
  // Added items are never asserted pre-ranked: append as a singleton run
  // (full-range insert) when run tracking is active; leave it off
  // otherwise so the flat path stays run-free.
  if (next.pendingRunIds) {
    next.pendingRunIds = [...next.pendingRunIds, freshRunId(next)];
  }
  if (next.done) next.done = false;
  drainPending(next);
  // bumpTotalComparisons walks the projected plan; the newly-pushed id
  // contributes its own ⌈log2⌉ cost since pending now includes it.
  bumpTotalComparisons(next);
  return { ...next, items: { ...state.items, [item.id]: item } };
}

/**
 * Add a batch of items to the back of `pending` (FIFO, input order).
 * Ignores input rank — each item gets its own full-range insert (a fresh
 * singleton run when run tracking is active). Rank-aware tightening is
 * reserved for the pre-ranked SEED path (`seedInsertionFromSublists`),
 * where the caller asserts each sublist is in true rank order; an ad-hoc
 * batch add carries no such guarantee.
 * Returns `{state, skipped}` like appendPreRankedSublist.
 */
export function addItems(
  state: InsertionState,
  items: Item[],
): { state: InsertionState; skipped: ItemId[] } {
  const skipped: ItemId[] = [];
  const survivors: Item[] = [];
  for (const it of items) {
    if (state.items[it.id]) skipped.push(it.id);
    else survivors.push(it);
  }
  if (survivors.length === 0) return { state, skipped };

  const next = snapshotProgress(state);
  next.pending = [...next.pending, ...survivors.map((it) => it.id)];
  if (next.pendingRunIds) {
    let base = freshRunId(next);
    next.pendingRunIds = [
      ...next.pendingRunIds,
      ...survivors.map(() => base++),
    ];
  }
  if (next.done) next.done = false;
  bumpTotalComparisons(next);
  drainPending(next);
  const itemsDict = { ...state.items };
  for (const it of survivors) itemsDict[it.id] = it;
  return {
    state: { ...next, items: itemsDict },
    skipped,
  };
}
