/**
 * Engine-dispatching facade. Wraps the two engines (queueMergeSort,
 * insertionSort) behind a small set of polymorphic operations keyed on
 * `state.engine`.
 *
 * App.tsx and screen components use these helpers so they don't have to
 * narrow at every call site. Engine-specific operations (queue
 * reorder/break-apart, manual-insert Insert/Forget, insertion addItems) still
 * live on the engine modules and are wired up only on the screens that
 * make sense for them.
 *
 * Cross-engine undo: `restoreProgress` dispatches on the *snapshotted*
 * progress's engine (not the current state's engine), so an undo from a
 * normalized completion restores the in-progress insertion snapshot.
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

/**
 * Up to `n` rank-adjacent visible ids on the RIGHT card's side. Drives
 * the peek deck rendered behind B in CompareScreen. Returns [] when no
 * compare is active or none of the candidates are visible. See the
 * per-engine implementations for dispatch details (insertion uses the
 * active probe; merge dispatches manual-insert > auto-insert > merge).
 */
export function getPeekRightIds(state: SortState, n = 3): ItemId[] {
  return state.engine === 'insertion'
    ? insertion.getPeekRightIds(state, n)
    : merge.getPeekRightIds(state, n);
}

/**
 * Up to `n` rank-adjacent visible ids on the LEFT card's side. Only
 * non-empty in normal merge mode (left is also a sublist head). All
 * insert modes return [] because the left card is the single inserting
 * item with no rank-adjacent neighbor. CompareScreen uses [] to skip
 * rendering the left deck entirely.
 */
export function getPeekLeftIds(state: SortState, n = 3): ItemId[] {
  return state.engine === 'insertion'
    ? insertion.getPeekLeftIds(state, n)
    : merge.getPeekLeftIds(state, n);
}

/** Count of rank-adjacent ids not shown as named peek cards (`...n` tail). */
export function getPeekRightOverflowCount(
  state: SortState,
  labeledDepth: number,
): number {
  return state.engine === 'insertion'
    ? insertion.getPeekRightOverflowCount(state, labeledDepth)
    : merge.getPeekRightOverflowCount(state, labeledDepth);
}

export function getPeekLeftOverflowCount(
  state: SortState,
  labeledDepth: number,
): number {
  return state.engine === 'insertion'
    ? insertion.getPeekLeftOverflowCount(state, labeledDepth)
    : merge.getPeekLeftOverflowCount(state, labeledDepth);
}

// ---------- snapshot / restore ----------

export function snapshotProgress(state: SortState): SortProgress {
  return state.engine === 'insertion'
    ? insertion.snapshotProgress(state)
    : merge.snapshotProgress(state);
}

/**
 * Restore the snapshot onto a state. Dispatches on the *snapshot's*
 * engine so an undo from normalized completion restores in-progress
 * insertion. `items` is shared between snapshots (we never destroy
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
  const next =
    state.engine === 'insertion'
      ? insertion.pickLeft(state)
      : merge.pickLeft(state, options);
  return finalizeCompletedState(next);
}

export function pickRight(
  state: SortState,
  options?: EngineOptions,
): SortState {
  const next =
    state.engine === 'insertion'
      ? insertion.pickRight(state)
      : merge.pickRight(state, options);
  return finalizeCompletedState(next);
}

// ---------- hide / unhide ----------

export function hideItem(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  const next =
    state.engine === 'insertion'
      ? insertion.hideItem(state, id)
      : merge.hideItem(state, id, options);
  return finalizeCompletedState(next);
}

export function unhideItem(state: SortState, id: ItemId): SortState {
  return state.engine === 'insertion'
    ? insertion.unhideItem(state, id)
    : merge.unhideItem(state, id);
}

/** Permanently clear a hidden id (no restore). */
export function dismissHidden(state: SortState, id: ItemId): SortState {
  return state.engine === 'insertion'
    ? insertion.dismissHidden(state, id)
    : merge.dismissHidden(state, id);
}

/**
 * Permanently remove a hidden item from the sort (ranking slots + hidden bit).
 * Orphans only clear the hidden entry.
 */
export function forgetHiddenItem(
  state: SortState,
  id: ItemId,
  options?: MergeOptions,
): SortState {
  return state.engine === 'insertion'
    ? insertion.forgetHiddenItem(state, id)
    : merge.forgetHiddenItem(state, id, options);
}

/**
 * Restore a hidden item that is no longer in any ranking slot. Re-queues
 * it for sorting; in-ranking hidden ids just unhide.
 */
export function restoreHiddenItem(
  state: SortState,
  id: ItemId,
  options?: MergeOptions,
): SortState {
  return state.engine === 'insertion'
    ? insertion.restoreHiddenItem(state, id)
    : merge.restoreHiddenItem(state, id, options);
}

/**
 * Patch the metadata of a single item (label / url / imageUrl) without
 * touching the sort structure. Engine-agnostic because both engines
 * share the same `items` dict and the item's `id` is the only thing
 * the queue/sorted/pending/toBeInserted/etc. arrays actually reference.
 *
 * Driving use-case: pasted lists whose labels contain a comma get
 * mis-parsed (comma is treated as the CSV column separator, so the
 * tail of the label leaks into the `url` column). The user wants to
 * fix the affected item in place after the fact rather than start
 * over.
 *
 * Patch semantics:
 *  - `label`: defined → set to the trimmed value; empty trimmed value
 *    is rejected (we never want a blank label) and we return the
 *    state unchanged.
 *  - `url` / `imageUrl`: defined and non-empty → set; defined and
 *    empty string → cleared (`undefined`). This is how the user
 *    removes a bogus URL that came from a comma split.
 *
 * The item `id` is intentionally NOT recomputed from the new label.
 * The id is referenced by every collection in the sort state
 * (queue, sublists, hidden[], toBeInserted[], pending[], sorted[],
 * pendingManualInserts[], currentManualInsert.insertingId, etc.) and
 * is internal — the user never sees it. Keeping it stable means a
 * label edit is a strict in-place patch with no structural risk.
 *
 * Returns the input state unchanged when the id is unknown or the
 * patch is a no-op (so the caller can skip pushing a useless undo
 * frame).
 */
export function updateItem(
  state: SortState,
  id: ItemId,
  patch: { label?: string; url?: string; imageUrl?: string },
): SortState {
  const existing = state.items[id];
  if (!existing) return state;
  const next: Item = { ...existing };
  let changed = false;
  if (patch.label !== undefined) {
    const trimmed = patch.label.trim();
    if (trimmed.length === 0) return state; // refuse blank labels
    if (trimmed !== existing.label) {
      next.label = trimmed;
      changed = true;
    }
  }
  if (patch.url !== undefined) {
    const trimmed = patch.url.trim();
    const nextUrl = trimmed.length === 0 ? undefined : trimmed;
    if (nextUrl !== existing.url) {
      next.url = nextUrl;
      changed = true;
    }
  }
  if (patch.imageUrl !== undefined) {
    const trimmed = patch.imageUrl.trim();
    const nextImg = trimmed.length === 0 ? undefined : trimmed;
    if (nextImg !== existing.imageUrl) {
      next.imageUrl = nextImg;
      changed = true;
    }
  }
  if (!changed) return state;
  // Patch via spread on the items dict. Engine-specific state arrays
  // are untouched — id is the only thing they reference, and id is
  // unchanged.
  return { ...state, items: { ...state.items, [id]: next } } as SortState;
}

/**
 * Rewrite every `ItemId` reference inside a progress slice. Used by
 * `updateItemId` to keep the sort-state arrays in sync with a renamed
 * id, and exported separately so callers (App.tsx) can apply the same
 * rewrite to every snapshot in the undo ring — otherwise an undo
 * after a rename would resurrect a stale id that no longer keys the
 * items dict and the UI would render blanks for those references.
 *
 * Pure: returns a new progress object with the same shape but with
 * `oldId` replaced by `newId` wherever it appears in nested arrays,
 * single-id fields, and frame structures. If `oldId` doesn't appear
 * anywhere in the progress, the returned object is structurally
 * equal to the input (we still return a fresh object — callers
 * generally don't care, and skipping the spread doesn't buy much).
 */
export function rewriteIdInProgress(
  progress: SortProgress,
  oldId: ItemId,
  newId: ItemId,
): SortProgress {
  if (oldId === newId) return progress;
  const mapId = (id: ItemId): ItemId => (id === oldId ? newId : id);
  const mapArr = (ids: ItemId[]): ItemId[] => ids.map(mapId);
  if (progress.engine === 'insertion') {
    return {
      ...progress,
      sorted: mapArr(progress.sorted),
      pending: mapArr(progress.pending),
      hidden: mapArr(progress.hidden),
      current:
        progress.current === null
          ? null
          : { ...progress.current, insertingId: mapId(progress.current.insertingId) },
    };
  }
  // merge engine
  return {
    ...progress,
    queue: progress.queue.map(mapArr),
    hidden: mapArr(progress.hidden),
    toBeInserted: mapArr(progress.toBeInserted),
    pendingManualInserts: mapArr(progress.pendingManualInserts),
    current:
      progress.current === null
        ? null
        : {
            left: mapArr(progress.current.left),
            right: mapArr(progress.current.right),
            merged: mapArr(progress.current.merged),
          },
    currentManualInsert:
      progress.currentManualInsert === null
        ? null
        : {
            ...progress.currentManualInsert,
            insertingId: mapId(progress.currentManualInsert.insertingId),
            frame: {
              ...progress.currentManualInsert.frame,
              insertingId: mapId(progress.currentManualInsert.frame.insertingId),
            },
          },
    currentAutoInsert:
      progress.currentAutoInsert === null
        ? null
        : {
            ...progress.currentAutoInsert,
            target: mapArr(progress.currentAutoInsert.target),
            pendingInserts: mapArr(progress.currentAutoInsert.pendingInserts),
            frame:
              progress.currentAutoInsert.frame === null
                ? null
                : {
                    ...progress.currentAutoInsert.frame,
                    insertingId: mapId(progress.currentAutoInsert.frame.insertingId),
                  },
          },
  };
}

/**
 * Rename the logical id of an item from `oldId` to `newId`. Returns
 * a new SortState with:
 *  - the items dict rekeyed (old entry dropped, new entry added with
 *    `id` field also updated so `item.id === <key>` stays invariant)
 *  - every `ItemId` reference in the progress slice rewritten via
 *    `rewriteIdInProgress`
 *
 * Rejections (return `null`):
 *  - `newId` is empty after trim
 *  - `oldId` is not present in `state.items`
 *  - `newId` already exists in `state.items` (collision)
 *
 * No-op shortcut (returns input state unchanged so the caller skips
 * pushing an undo frame):
 *  - `newId.trim() === oldId`
 *
 * IMPORTANT: this helper rewrites the live progress only. The undo
 * ring lives outside the engine (in App.tsx) and must be rewritten
 * by the caller using `rewriteIdInProgress` on each entry — otherwise
 * an undo after rename will restore an arrays-reference-old-id /
 * dict-keyed-by-new-id mismatch and the UI will render blanks.
 */
export function updateItemId(
  state: SortState,
  oldId: ItemId,
  newId: ItemId,
): SortState | null {
  const trimmed = newId.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === oldId) return state;
  const existing = state.items[oldId];
  if (!existing) return null;
  if (state.items[trimmed]) return null;
  // Rekey items dict and update the item's own id field to match.
  const { [oldId]: dropped, ...rest } = state.items;
  void dropped;
  const items = { ...rest, [trimmed]: { ...existing, id: trimmed } };
  // Pull the progress slice out (everything except items), rewrite,
  // and stitch back together. The cast through `unknown` is needed
  // because TS can't see that rewriteIdInProgress preserves the
  // discriminant.
  const progressOnly = stripItems(state);
  const rewritten = rewriteIdInProgress(progressOnly, oldId, trimmed);
  return { ...rewritten, items } as SortState;
}

/** Drop the `items` field for code that operates on progress only. */
function stripItems(state: SortState): SortProgress {
  if (state.engine === 'insertion') {
    const { items: _drop, ...rest } = state;
    void _drop;
    return rest as InsertionProgress;
  }
  const { items: _drop, ...rest } = state;
  void _drop;
  return rest as MergeProgress;
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
 * Pull an item out of the current ranking and queue it for a fresh
 * binary insertion:
 *  - insertion engine: remove from `sorted[]`, front of `pending[]`
 *  - merge engine: remove from `queue[]`, manual-insert drain
 *
 * Used by the per-row ↻ button on the completed Sorted list (LIST tab).
 */
export function returnToPending(state: SortState, id: ItemId): SortState {
  return state.engine === 'insertion'
    ? insertion.returnToPending(state, id)
    : merge.returnToPending(state, id);
}

/**
 * Pull a hidden item back out for a fresh binary insert. In-ranking ids
 * are unhidden then `returnToPending`; orphans delegate to
 * `restoreHiddenItem`.
 */
export function reinsertHiddenItem(
  state: SortState,
  id: ItemId,
  options?: MergeOptions,
): SortState {
  if (!state.hidden.includes(id)) return state;
  if (state.engine === 'insertion') {
    const inRanking =
      state.sorted.includes(id) || state.pending.includes(id);
    if (inRanking) {
      return insertion.returnToPending(insertion.unhideItem(state, id), id);
    }
    return insertion.restoreHiddenItem(state, id);
  }
  const inRanking =
    state.queue.some((sub) => sub.includes(id)) ||
    state.toBeInserted.includes(id);
  if (inRanking) {
    return merge.returnToPending(merge.unhideItem(state, id), id, options);
  }
  return merge.restoreHiddenItem(state, id, options);
}

// ---------- completion normalization ----------

/**
 * Completed sorts use a canonical merge-engine `done` shape so every
 * finished slot shares the same add-item / pre-ranked / undo semantics.
 * In-progress states pass through unchanged.
 *
 * Call synchronously at completion time (after the undo snapshot already
 * captured the in-progress insertion shape) and when loading legacy
 * `done + insertion` blobs — never push an extra undo entry for this step.
 */
export function finalizeCompletedState(state: SortState): SortState {
  if (!state.done || state.engine === 'merge') return state;
  const ranking = state.sorted.slice();
  const mergeState: MergeState = {
    engine: 'merge',
    queue: [ranking],
    current: null,
    comparisons: state.comparisons,
    done: true,
    hidden: state.hidden.slice(),
    totalComparisonsEverNeeded: state.totalComparisonsEverNeeded,
    toBeInserted: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
    items: state.items,
  };
  return mergeState;
}
