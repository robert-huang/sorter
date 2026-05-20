/**
 * Engine-dispatching facade. Wraps the two engines (queueMergeSort,
 * insertionSort) behind a small set of polymorphic operations keyed on
 * `state.engine`.
 *
 * App.tsx and screen components use these helpers so they don't have to
 * narrow at every call site. Engine-specific operations (queue
 * reorder/break-apart, placement Place/Forget, insertion addItems) still
 * live on the engine modules and are wired up only on the screens that
 * make sense for them.
 *
 * Cross-engine undo: `restoreProgress` dispatches on the *snapshotted*
 * progress's engine (not the current state's engine), so an undo across
 * a merge→insertion transition flips the state shape back correctly.
 */
import * as merge from './queueMergeSort';
import * as insertion from './insertionSort';
import type { MergeOptions } from './queueMergeSort';
import type {
  InsertionProgress,
  InsertionState,
  Item,
  ItemId,
  MergeProgress,
  MergeState,
  SortProgress,
  SortState,
} from './types';

/**
 * Re-export the merge engine's options bag so callers (App.tsx,
 * sessionR.ts) can construct typed settings objects without importing
 * from the engine module directly.
 */
export type EngineOptions = MergeOptions;

// ---------- pure readers ----------

export function getPair(
  state: SortState,
): { leftId: ItemId; rightId: ItemId } | null {
  return state.engine === 'insertion'
    ? insertion.getPair(state)
    : merge.getPair(state);
}

export function comparisonsRemaining(
  state: SortState,
  options?: EngineOptions,
): number {
  return state.engine === 'insertion'
    ? insertion.comparisonsRemaining(state)
    : merge.comparisonsRemaining(state, options);
}

export function getRanking(state: SortState): ItemId[] {
  return state.engine === 'insertion'
    ? insertion.getRanking(state)
    : merge.getRanking(state);
}

// ---------- snapshot / restore ----------

export function snapshotProgress(state: SortState): SortProgress {
  return state.engine === 'insertion'
    ? insertion.snapshotProgress(state)
    : merge.snapshotProgress(state);
}

/**
 * Restore the snapshot onto a state. Dispatches on the *snapshot's*
 * engine so an undo across a merge→insertion transition flips state
 * shape back. `items` is shared between snapshots (we never destroy
 * items, only add them).
 */
export function restoreProgress(
  state: SortState,
  progress: SortProgress,
): SortState {
  if (progress.engine === 'insertion') {
    // Build a placeholder InsertionState so insertion.restoreProgress
    // can splice items in. items dict comes from `state`.
    const placeholder: InsertionState = {
      ...(progress as InsertionProgress),
      items: state.items,
    };
    return insertion.restoreProgress(placeholder, progress);
  }
  const placeholder: MergeState = {
    ...(progress as MergeProgress),
    items: state.items,
  };
  return merge.restoreProgress(placeholder, progress);
}

// ---------- picks ----------

export function pickLeft(
  state: SortState,
  options?: EngineOptions,
): SortState {
  return state.engine === 'insertion'
    ? insertion.pickLeft(state)
    : merge.pickLeft(state, options);
}

export function pickRight(
  state: SortState,
  options?: EngineOptions,
): SortState {
  return state.engine === 'insertion'
    ? insertion.pickRight(state)
    : merge.pickRight(state, options);
}

// ---------- hide / unhide ----------

export function hideItem(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  return state.engine === 'insertion'
    ? insertion.hideItem(state, id)
    : merge.hideItem(state, id, options);
}

export function unhideItem(state: SortState, id: ItemId): SortState {
  return state.engine === 'insertion'
    ? insertion.unhideItem(state, id)
    : merge.unhideItem(state, id);
}

// ---------- add items (engine-aware) ----------

/**
 * Add a single item to the in-flight sort, dispatching to the right
 * engine. Returns null if the item id is already present (matches
 * each engine's contract).
 */
export function addItem(
  state: SortState,
  item: Item,
  options?: EngineOptions,
): SortState | null {
  return state.engine === 'insertion'
    ? insertion.addItem(state, item)
    : merge.addItem(state, item, options);
}

/**
 * Batch-add a list of items. Matches the "Multiple" tab of the LIST tab's
 * unified add-items modal: each item is treated as an individual add.
 *
 * - Insertion engine → appends survivors to `pending[]` in input order
 *   (FIFO drain).
 * - Merge engine → appends N singleton sublists to the back of the queue
 *   (preserves input order in queue order, NOT as a single ranked sublist
 *   — use the `appendPreRanked` path for that semantic).
 *
 * Returns the new state plus the ids of items that were skipped because
 * their id was already present.
 */
export function addItems(
  state: SortState,
  items: Item[],
  options?: EngineOptions,
): { state: SortState; skipped: ItemId[] } {
  if (state.engine === 'insertion') {
    return insertion.addItems(state, items);
  }
  return merge.addItems(state, items, options);
}

// ---------- insertion-only mutations (freeze-relax) ----------

/**
 * Insertion engine: swap two adjacent items in the frozen `sorted[]`
 * (direction: -1 = up, +1 = down). Cancels and restarts any in-flight
 * binary-insertion frame since its bounds reference stale indices.
 *
 * No-op on a merge state (sorted-list mutations only make sense once
 * the merge has collapsed to an insertion).
 */
export function reorderInSorted(
  state: SortState,
  sortedIndex: number,
  direction: -1 | 1,
): SortState {
  if (state.engine !== 'insertion') return state;
  return insertion.reorderInSorted(state, sortedIndex, direction);
}

/**
 * Insertion engine: take an id out of `sorted[]` and put it back at the
 * front of `pending[]` so it gets a fresh binary insertion next. Used
 * by the per-row ↻ button on the insertion-mode Sorted list.
 *
 * No-op on a merge state.
 */
export function returnToPending(state: SortState, id: ItemId): SortState {
  if (state.engine !== 'insertion') return state;
  return insertion.returnToPending(state, id);
}

// ---------- engine transition ----------

/**
 * Convert a merge-engine state into an insertion-engine state, using
 * the merge's final ranking as the frozen `sorted[]` and the provided
 * `newItems` as the FIFO `pending[]`. Used by the "+ Add items" button
 * on the RESULT screen when the user wants to insert new items into a
 * completed merge sort without re-running merges over the existing
 * ranking.
 *
 * Requires the merge state to be `done`. (If the user wants to add
 * items mid-sort, they go through `merge.addItem` instead — that's
 * still queue-based and stays on the merge engine.)
 *
 * Items in `newItems` that match an id already present in `mergeState.items`
 * are dedup-skipped (returned in `skipped`), same contract as
 * appendPreRankedSublist + insertion.addItems.
 *
 * Undo across this boundary works automatically: callers push the
 * merge-state snapshot onto the undo ring before calling this; the
 * undo path's `restoreProgress` dispatches on the snapshot's engine
 * and flips back.
 */
export function transitionMergeDoneToInsertion(
  mergeState: MergeState,
  newItems: Item[],
): { state: InsertionState; skipped: ItemId[] } {
  if (!mergeState.done) {
    throw new Error(
      'transitionMergeDoneToInsertion: merge state must be done',
    );
  }
  const ranking = merge.getRanking(mergeState);
  const sortedItems = ranking
    .map((id) => mergeState.items[id])
    .filter((it): it is Item => !!it);
  // Preserve the hidden bit so removed items are still listed under
  // the "removed during sorting" toggle on the RESULT screen.
  const carriedHidden = mergeState.hidden.slice();
  return insertion.buildInsertionState({
    sortedItems,
    pendingItems: newItems,
    hidden: carriedHidden,
  });
}
