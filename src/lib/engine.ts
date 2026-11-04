/**
 * Engine-dispatching facade. Wraps the merge, insertion, and confirmation
 * engines behind a small set of polymorphic operations keyed on `state.engine`.
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
import * as confirmation from './confirmationSort';
import type { MergeOptions } from './queueMergeSort';
import { cloneSection, frozenSectionIds, sectionField } from './sectionResortShape';
import { activeRankingIds } from './sortPopulation';
import type {
  ConfirmationProgress,
  ConfirmationState,
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

function byEngine<T>(
  state: SortState,
  handlers: {
    merge: (s: MergeState) => T;
    insertion: (s: InsertionState) => T;
    confirmation: (s: ConfirmationState) => T;
  },
): T {
  if (state.engine === 'confirmation') return handlers.confirmation(state);
  if (state.engine === 'insertion') return handlers.insertion(state);
  return handlers.merge(state);
}

// ---------- section re-sort: frozen ids outside the range ----------

function isFrozenId(state: SortProgress, id: ItemId): boolean {
  return frozenSectionIds(state.section).has(id);
}

/** Engine ops that rebuild state from scratch must not drop the section context. */
function carrySection<T extends SortState>(prev: SortState, next: T): T {
  if (!prev.section || next.section || next === prev) return next;
  return { ...next, section: cloneSection(prev.section) };
}

/** `carrySection`, then splice if the section just finished. No-op for normal sorts. */
function settleSection<T extends SortState>(prev: SortState, next: T): SortState {
  if (!prev.section) return next;
  return finalizeCompletedState(carrySection(prev, next));
}

/** Removes a frozen id from its part of the section (it stays in `hidden` if it was). */
function withoutFrozenId(state: SortState, id: ItemId): SortState {
  const section = state.section;
  if (!section) return state;
  const drop = (ids: ItemId[]): ItemId[] => ids.filter((x) => x !== id);
  return {
    ...state,
    section: {
      ...cloneSection(section)!,
      before: drop(section.before),
      after: drop(section.after),
      tailPlaceholders: drop(section.tailPlaceholders),
    },
  };
}

function hideFrozenId(state: SortState, id: ItemId): SortState {
  if (state.hidden.includes(id)) return state;
  return { ...state, hidden: [...state.hidden, id].sort() } as SortState;
}

function unhideFrozenId(state: SortState, id: ItemId): SortState {
  if (!state.hidden.includes(id)) return state;
  return { ...state, hidden: state.hidden.filter((h) => h !== id) } as SortState;
}

/** Moves a frozen id into the re-sorted range as a newly added item. */
function moveFrozenIdIntoSection(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  const item = state.items[id];
  if (!item) return state;
  const pulled = unhideFrozenId(withoutFrozenId(state, id), id);
  const added = addItem(pulled, item, options);
  return added ?? state;
}

/**
 * Splits an add batch around the section: hidden frozen ids leave the frozen
 * rows and go to the engine as fresh adds (like adding any hidden item),
 * visible frozen ids are skipped, everything else goes to the engine.
 */
function routeFrozenAdds(
  state: SortState,
  items: Item[],
): { state: SortState; remaining: Item[]; skipped: ItemId[]; restored: ItemId[] } {
  if (!state.section) return { state, remaining: items, skipped: [], restored: [] };
  let cur = state;
  const remaining: Item[] = [];
  const skipped: ItemId[] = [];
  const restored: ItemId[] = [];
  for (const it of items) {
    if (!isFrozenId(cur, it.id)) {
      remaining.push(it);
    } else if (cur.hidden.includes(it.id)) {
      cur = unhideFrozenId(withoutFrozenId(cur, it.id), it.id);
      remaining.push(it);
      restored.push(it.id);
    } else {
      skipped.push(it.id);
    }
  }
  return { state: cur, remaining, skipped, restored };
}

/**
 * Swaps a visible frozen row with its visible neighbour inside `before` or
 * `after`. Moving past the range boundary is a no-op: the only way into the
 * range is ↻ (`returnToPending` / `reinsertHiddenItem`).
 */
export function moveFrozenItem(
  state: SortState,
  id: ItemId,
  direction: -1 | 1,
): SortState {
  const section = state.section;
  if (!section) return state;
  // Tail placeholders splice in directly above `after`, so they move as one block.
  const below = [...section.tailPlaceholders, ...section.after];
  const inBefore = section.before.includes(id);
  if (!inBefore && !below.includes(id)) return state;
  const ids = inBefore ? section.before.slice() : below;
  const hidden = new Set(state.hidden);
  const visible = ids.filter((x) => !hidden.has(x));
  const target = visible[visible.indexOf(id) + direction];
  if (target === undefined) return state;
  const a = ids.indexOf(id);
  const b = ids.indexOf(target);
  ids[a] = target;
  ids[b] = id;
  const next = cloneSection(section)!;
  if (inBefore) {
    next.before = ids;
  } else {
    next.tailPlaceholders = ids.slice(0, section.tailPlaceholders.length);
    next.after = ids.slice(section.tailPlaceholders.length);
  }
  return { ...state, section: next };
}

/** Puts the finished ranking back exactly as it was before the section re-sort started. */
export function cancelSectionResort(state: SortState): SortState {
  const section = state.section;
  if (!section) return state;
  const exists = (id: ItemId): boolean => !!state.items[id];
  const originalIds = new Set([
    ...section.originalOrder,
    ...section.originalHidden,
    ...(section.originalToBeInserted ?? []),
  ]);
  // Items added during the re-sort have no rank to return to, so they go to Hidden.
  const added = [...activeRankingIds(state), ...state.hidden].filter(
    (id) => !originalIds.has(id) && exists(id),
  );
  const restored: MergeState = {
    engine: 'merge',
    queue: [section.originalOrder.filter(exists)],
    current: null,
    comparisons: section.priorComparisons,
    done: true,
    hidden: [...new Set([...section.originalHidden.filter(exists), ...added])],
    totalComparisonsEverNeeded: section.priorTotalComparisonsEverNeeded,
    toBeInserted: (section.originalToBeInserted ?? []).filter(exists),
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
    items: state.items,
  };
  return restored;
}

/** Visible frozen ranking around the live section, for LIST. */
export function getSectionFrozenRows(
  state: SortState,
): { before: ItemId[]; after: ItemId[] } | null {
  const section = state.section;
  if (!section) return null;
  const hidden = new Set(state.hidden);
  return {
    before: section.before.filter((id) => !hidden.has(id)),
    after: section.after.filter((id) => !hidden.has(id)),
  };
}

// ---------- pure readers ----------

export function getPair(
  state: SortState,
): { leftId: ItemId; rightId: ItemId } | null {
  return byEngine(state, {
    merge: (s) => merge.getPair(s),
    insertion: (s) => insertion.getPair(s),
    confirmation: (s) => confirmation.getPair(s),
  });
}

export function comparisonsRemaining(
  state: SortState,
  options?: EngineOptions,
): number {
  return byEngine(state, {
    merge: (s) => merge.comparisonsRemaining(s, options),
    insertion: (s) => insertion.comparisonsRemaining(s),
    confirmation: (s) => confirmation.comparisonsRemaining(s),
  });
}

/** Best-case remaining comparisons (all future left-click confirms). */
export function optimisticComparisonsRemaining(state: SortState): number {
  return byEngine(state, {
    merge: (s) => merge.comparisonsRemaining(s),
    insertion: (s) => insertion.comparisonsRemaining(s),
    confirmation: (s) => confirmation.optimisticComparisonsRemaining(s),
  });
}

/**
 * Progress for the compare-screen bar and document.title. Confirmation mode
 * uses equal per-item sections, while the other engines use their remaining-
 * comparisons forecast. When `state.done`, the sort is complete.
 */
export function getCompareProgress(
  state: SortState,
  options?: EngineOptions,
): { completed: number; total: number; pct: number } {
  if (state.engine === 'confirmation') {
    return confirmation.getItemProgress(state);
  }
  const total = state.totalComparisonsEverNeeded ?? 0;
  if (total === 0) {
    return { completed: 0, total: 0, pct: 0 };
  }
  if (state.done) {
    return { completed: total, total, pct: 100 };
  }
  const remaining = comparisonsRemaining(state, options);
  const completed = Math.max(0, total - remaining);
  const pct = Math.min(99.9, Math.round((completed / total) * 1000) / 10);
  return { completed, total, pct };
}

export function getRanking(state: SortState): ItemId[] {
  return byEngine(state, {
    merge: (s) => merge.getRanking(s),
    insertion: (s) => insertion.getRanking(s),
    confirmation: (s) => confirmation.getRanking(s),
  });
}

/**
 * Up to `n` rank-adjacent visible ids on the RIGHT card's side. Drives
 * the peek deck rendered behind B in CompareScreen. Returns [] when no
 * compare is active or none of the candidates are visible. See the
 * per-engine implementations for dispatch details (insertion uses the
 * active probe; merge dispatches manual-insert > auto-insert > merge).
 */
export function getPeekRightIds(state: SortState, n = 3): ItemId[] {
  return byEngine(state, {
    merge: (s) => merge.getPeekRightIds(s, n),
    insertion: (s) => insertion.getPeekRightIds(s, n),
    confirmation: (s) => confirmation.getPeekRightIds(s, n),
  });
}

/**
 * Up to `n` rank-adjacent visible ids on the LEFT card's side. Only
 * non-empty in normal merge mode (left is also a sublist head). All
 * insert modes return [] because the left card is the single inserting
 * item with no rank-adjacent neighbor. CompareScreen uses [] to skip
 * rendering the left deck entirely.
 */
export function getPeekLeftIds(state: SortState, n = 3): ItemId[] {
  return byEngine(state, {
    merge: (s) => merge.getPeekLeftIds(s, n),
    insertion: (s) => insertion.getPeekLeftIds(s, n),
    confirmation: (s) => confirmation.getPeekLeftIds(s, n),
  });
}

/** Count of rank-adjacent ids not shown as named peek cards (`...n` tail). */
export function getPeekRightOverflowCount(
  state: SortState,
  labeledDepth: number,
): number {
  return byEngine(state, {
    merge: (s) => merge.getPeekRightOverflowCount(s, labeledDepth),
    insertion: (s) => insertion.getPeekRightOverflowCount(s, labeledDepth),
    confirmation: (s) => confirmation.getPeekRightOverflowCount(s, labeledDepth),
  });
}

export function getPeekLeftOverflowCount(
  state: SortState,
  labeledDepth: number,
): number {
  return byEngine(state, {
    merge: (s) => merge.getPeekLeftOverflowCount(s, labeledDepth),
    insertion: (s) => insertion.getPeekLeftOverflowCount(s, labeledDepth),
    confirmation: (s) => confirmation.getPeekLeftOverflowCount(s, labeledDepth),
  });
}

// ---------- snapshot / restore ----------

export function snapshotProgress(state: SortState): SortProgress {
  return byEngine<SortProgress>(state, {
    merge: (s) => merge.snapshotProgress(s),
    insertion: (s) => insertion.snapshotProgress(s),
    confirmation: (s) => confirmation.snapshotProgress(s),
  });
}

/** True when two undo frames carry identical engine progress. */
export function undoSnapshotsEqual(
  a: SortProgress,
  b: SortProgress,
): boolean {
  if (a.engine !== b.engine) return false;
  if (a.comparisons !== b.comparisons || a.done !== b.done) return false;
  if (a.engine === 'confirmation') {
    const ca = a as ConfirmationProgress;
    const cb = b as ConfirmationProgress;
    return (
      ca.phase === cb.phase &&
      ca.candidate === cb.candidate &&
      ca.confirmed.length === cb.confirmed.length &&
      ca.confirmed.every((id, i) => id === cb.confirmed[i]) &&
      ca.queue.length === cb.queue.length &&
      ca.queue.every((id, i) => id === cb.queue[i]) &&
      ca.hidden.length === cb.hidden.length &&
      ca.hidden.every((id, i) => id === cb.hidden[i]) &&
      JSON.stringify(ca.insertFrame) === JSON.stringify(cb.insertFrame) &&
      JSON.stringify(ca.section) === JSON.stringify(cb.section)
    );
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * During confirmation insert, reorder/hide can push undo frames at the same
 * comparison depth without a new pick. Skip those so one undo exits insert.
 */
export function shouldSkipConfirmationInsertUndo(
  current: SortState,
  snapshot: SortProgress,
): boolean {
  if (current.engine !== 'confirmation' || snapshot.engine !== 'confirmation') {
    return false;
  }
  const cur = current as ConfirmationState;
  const snap = snapshot as ConfirmationProgress;
  return (
    cur.phase === 'insert' &&
    snap.phase === 'insert' &&
    snap.comparisons === cur.comparisons
  );
}

/**
 * Pop the undo ring back to a meaningful snapshot — skipping duplicate
 * confirmation-insert frames at the same comparison depth.
 */
export function selectUndoSnapshot(
  current: SortState,
  ring: SortProgress[],
): { snapshot: SortProgress; newRing: SortProgress[] } | null {
  if (ring.length === 0) return null;
  let idx = ring.length - 1;
  while (idx >= 0) {
    const snapshot = ring[idx]!;
    if (!shouldSkipConfirmationInsertUndo(current, snapshot)) {
      return { snapshot, newRing: ring.slice(0, idx) };
    }
    idx -= 1;
  }
  return null;
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
  if (progress.engine === 'confirmation') {
    const placeholder: ConfirmationState = {
      ...(progress as ConfirmationProgress),
      items: state.items,
    };
    return confirmation.restoreProgress(placeholder, progress as ConfirmationProgress);
  }
  if (progress.engine === 'insertion') {
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
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.pickLeft(s, options),
    insertion: (s) => insertion.pickLeft(s),
    confirmation: (s) => confirmation.pickLeft(s),
  });
  return finalizeCompletedState(carrySection(state, next));
}

export function pickRight(
  state: SortState,
  options?: EngineOptions,
): SortState {
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.pickRight(s, options),
    insertion: (s) => insertion.pickRight(s),
    confirmation: (s) => confirmation.pickRight(s),
  });
  return finalizeCompletedState(carrySection(state, next));
}

export type PickSide = 'left' | 'right';

/**
 * Translate an on-screen pick to the engine facade action that represents it.
 *
 * Binary-insertion pairs expose inserting-left / probe-right, while the UI
 * displays probe-left / inserting-right. Confirmation already defines its
 * pickLeft / pickRight facade in visual terms, including its insert phase.
 */
export function getEnginePickSideForVisualSide(
  state: SortState,
  visualSide: PickSide,
): PickSide {
  if (state.engine === 'confirmation') return visualSide;

  const swapsSides =
    state.engine === 'insertion' ||
    state.currentManualInsert !== null ||
    state.currentAutoInsert?.frame != null;
  if (!swapsSides) return visualSide;
  return visualSide === 'left' ? 'right' : 'left';
}

/** Apply a comparison choice by the side currently displayed to the user. */
export function pickVisualSide(
  state: SortState,
  visualSide: PickSide,
  options?: EngineOptions,
): SortState {
  const engineSide = getEnginePickSideForVisualSide(state, visualSide);
  return engineSide === 'left'
    ? pickLeft(state, options)
    : pickRight(state, options);
}

// ---------- hide / unhide ----------

export function hideItem(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  if (isFrozenId(state, id)) return hideFrozenId(state, id);
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.hideItem(s, id, options),
    insertion: (s) => insertion.hideItem(s, id),
    confirmation: (s) => confirmation.hideItem(s, id),
  });
  return finalizeCompletedState(carrySection(state, next));
}

export function unhideItem(state: SortState, id: ItemId): SortState {
  if (isFrozenId(state, id)) return unhideFrozenId(state, id);
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.unhideItem(s, id),
    insertion: (s) => insertion.unhideItem(s, id),
    confirmation: (s) => confirmation.unhideItem(s, id),
  });
  return carrySection(state, next);
}

/** Permanently clear a hidden id (no restore). */
export function dismissHidden(state: SortState, id: ItemId): SortState {
  if (isFrozenId(state, id)) return unhideFrozenId(state, id);
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.dismissHidden(s, id),
    insertion: (s) => insertion.dismissHidden(s, id),
    confirmation: (s) => confirmation.dismissHidden(s, id),
  });
  return carrySection(state, next);
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
  if (isFrozenId(state, id)) {
    if (!state.hidden.includes(id)) return state;
    return unhideFrozenId(withoutFrozenId(state, id), id);
  }
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.forgetHiddenItem(s, id, options),
    insertion: (s) => insertion.forgetHiddenItem(s, id),
    confirmation: (s) => confirmation.forgetHiddenItem(s, id),
  });
  return settleSection(state, next);
}

/**
 * Hide an item without preserving its current rank. This deliberately uses
 * each engine's normal hide path first, then its structural removal path, so
 * active merge/insert frames advance exactly as they do for the visible
 * actions. Metadata and the hidden bit remain available for a later reinsert.
 */
export function hideItemUnranked(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  if (isFrozenId(state, id)) return hideFrozenId(withoutFrozenId(state, id), id);
  const hidden = hideItem(state, id, options);
  if (!hidden.hidden.includes(id)) return hidden;

  const withoutRank = forgetHiddenItem(hidden, id, options);
  return {
    ...withoutRank,
    hidden: [...withoutRank.hidden, id].sort(),
  };
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
  if (isFrozenId(state, id)) return unhideFrozenId(state, id);
  const next = byEngine<SortState>(state, {
    merge: (s) => merge.restoreHiddenItem(s, id, options),
    insertion: (s) => insertion.restoreHiddenItem(s, id),
    confirmation: (s) => confirmation.restoreHiddenItem(s, id),
  });
  return settleSection(state, next);
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
 *  - changing an AniList-backed label pins it as custom; explicitly
 *    requesting the automatic label clears that pin.
 *
 * The item `id` is intentionally NOT recomputed from the new label.
 * The id is referenced by every collection in the sort state
 * (queue, sublists, hidden[], toBeInserted[], pending[], sorted[],
 * pendingManualInserts[], currentManualInsert.insertingId, etc.) and
 * is internal — the user never sees it. Keeping it stable means a
 * label edit is a strict in-place patch with no structural risk.
 *
 * The item and state helpers preserve their respective input references
 * when the patch is a no-op.
 */
export interface ItemMetadataPatch {
  label?: string;
  url?: string;
  imageUrl?: string;
  useAutomaticAnilistLabel?: boolean;
}

export function updateItemMetadata(
  existing: Item,
  patch: ItemMetadataPatch,
): Item {
  if (patch.label !== undefined && patch.label.trim().length === 0) {
    return existing;
  }
  const next: Item = { ...existing };
  let changed = false;
  if (
    patch.useAutomaticAnilistLabel &&
    existing.anilistLabelMode === 'custom'
  ) {
    delete next.anilistLabelMode;
    delete next.anilistLabelIncludesFormat;
    changed = true;
  }
  if (patch.label !== undefined) {
    const trimmed = patch.label.trim();
    if (trimmed !== existing.label) {
      next.label = trimmed;
      changed = true;
      const sourceKind = existing.source?.kind;
      const isAnilistItem =
        existing.anilistLabelSource !== undefined ||
        sourceKind === 'anilist' ||
        sourceKind === 'anilist-character' ||
        sourceKind === 'anilist-staff';
      if (
        isAnilistItem &&
        !patch.useAutomaticAnilistLabel &&
        next.anilistLabelMode !== 'custom'
      ) {
        next.anilistLabelMode = 'custom';
        const labelSource = existing.anilistLabelSource;
        if (labelSource?.kind === 'media' && labelSource.format) {
          next.anilistLabelIncludesFormat = existing.label.endsWith(
            ` (${labelSource.format})`,
          );
        }
      }
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
  return changed ? next : existing;
}

export function updateItem(
  state: SortState,
  id: ItemId,
  patch: ItemMetadataPatch,
): SortState {
  const existing = state.items[id];
  if (!existing) return state;
  const next = updateItemMetadata(existing, patch);
  if (next === existing) return state;
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
  if (progress.section) {
    const s = progress.section;
    progress = {
      ...progress,
      section: {
        ...s,
        before: mapArr(s.before),
        after: mapArr(s.after),
        tailPlaceholders: mapArr(s.tailPlaceholders),
        originalOrder: mapArr(s.originalOrder),
        originalHidden: mapArr(s.originalHidden),
        ...(s.originalToBeInserted
          ? { originalToBeInserted: mapArr(s.originalToBeInserted) }
          : {}),
      },
    };
  }
  if (progress.engine === 'insertion') {
    return {
      ...progress,
      sorted: mapArr(progress.sorted),
      pending: mapArr(progress.pending),
      hidden: mapArr(progress.hidden),
      activeRunSourceIds: progress.activeRunSourceIds
        ? mapArr(progress.activeRunSourceIds)
        : undefined,
      activeRunUpperAnchorId: progress.activeRunUpperAnchorId
        ? mapId(progress.activeRunUpperAnchorId)
        : progress.activeRunUpperAnchorId,
      current:
        progress.current === null
          ? null
          : { ...progress.current, insertingId: mapId(progress.current.insertingId) },
    };
  }
  if (progress.engine === 'confirmation') {
    return {
      ...progress,
      confirmed: mapArr(progress.confirmed),
      queue: mapArr(progress.queue),
      candidate: progress.candidate ? mapId(progress.candidate) : null,
      hidden: mapArr(progress.hidden),
      insertFrame:
        progress.insertFrame === null
          ? null
          : {
              ...progress.insertFrame,
              insertingId: mapId(progress.insertFrame.insertingId),
            },
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
            ...(progress.currentAutoInsert.upperAnchorId != null
              ? { upperAnchorId: mapId(progress.currentAutoInsert.upperAnchorId) }
              : {}),
            sourceSublist: mapArr(
              progress.currentAutoInsert.sourceSublist ??
                [
                  progress.currentAutoInsert.frame?.insertingId,
                  ...progress.currentAutoInsert.pendingInserts,
                ].filter((id): id is string => id !== undefined),
            ),
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
  if (state.engine === 'confirmation') {
    const { items: _drop, ...rest } = state;
    void _drop;
    return rest as ConfirmationProgress;
  }
  const { items: _drop, ...rest } = state;
  void _drop;
  return rest as MergeProgress;
}

// ---------- add items (engine-aware) ----------

export interface AddItemsResult {
  state: SortState;
  skipped: ItemId[];
  /** Hidden ids reinserted instead of appended as new queue/pending entries. */
  restored: ItemId[];
}

/**
 * Add a single item to the in-flight sort, dispatching to the right
 * engine. Returns null if the item id is already present in active
 * ranking (matches each engine's contract). Hidden ids are reinserted.
 */
export function addItem(
  state: SortState,
  item: Item,
  options?: EngineOptions,
): SortState | null {
  if (isFrozenId(state, item.id)) {
    if (!state.hidden.includes(item.id)) return null;
    return addItem(unhideFrozenId(withoutFrozenId(state, item.id), item.id), item, options);
  }
  const next =
    state.engine === 'confirmation'
      ? confirmation.addItem(state, item)
      : state.engine === 'insertion'
        ? insertion.addItem(state, item)
        : merge.addItem(state, item, options);
  return next === null ? null : settleSection(state, next);
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
 * Returns the new state plus ids skipped (already in active ranking) and
 * restored (reinserted from hidden).
 */
export function addItems(
  state: SortState,
  items: Item[],
  options?: EngineOptions,
): AddItemsResult {
  const routed = routeFrozenAdds(state, items);
  const base = routed.state;
  const result =
    base.engine === 'confirmation'
      ? confirmation.addItems(base, routed.remaining)
      : base.engine === 'insertion'
        ? insertion.addItems(base, routed.remaining)
        : merge.addItems(base, routed.remaining, options);
  return {
    state: settleSection(base, result.state),
    skipped: [...routed.skipped, ...result.skipped],
    restored: [...routed.restored, ...result.restored],
  };
}

/** Merge-only pre-ranked append, routed around a section re-sort's frozen ids. */
export function appendPreRanked(
  state: MergeState,
  items: Item[],
  options?: EngineOptions,
): AddItemsResult {
  const routed = routeFrozenAdds(state, items);
  const base = routed.state as MergeState;
  const result = merge.appendPreRankedSublist(base, routed.remaining, options);
  return {
    state: settleSection(base, result.state),
    skipped: [...routed.skipped, ...result.skipped],
    restored: [...routed.restored, ...result.restored],
  };
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
  if (state.engine === 'confirmation') {
    return carrySection(
      state,
      confirmation.reorderInConfirmed(state, sortedIndex, direction),
    );
  }
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
export function returnToPending(
  state: SortState,
  id: ItemId,
  options?: EngineOptions,
): SortState {
  if (isFrozenId(state, id)) return moveFrozenIdIntoSection(state, id, options);
  const next =
    state.engine === 'confirmation'
      ? confirmation.returnCandidateToQueue(state, id)
      : state.engine === 'insertion'
        ? insertion.returnToPending(state, id)
        : merge.returnToPending(state, id);
  return settleSection(state, next);
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
  if (isFrozenId(state, id)) return moveFrozenIdIntoSection(state, id, options);
  return settleSection(state, reinsertHiddenItemInEngine(state, id, options));
}

function reinsertHiddenItemInEngine(
  state: SortState,
  id: ItemId,
  options?: MergeOptions,
): SortState {
  if (state.engine === 'confirmation') {
    if (state.confirmed.includes(id)) {
      return confirmation.returnCandidateToQueue(
        confirmation.unhideItem(state, id),
        id,
      );
    }
    return confirmation.restoreHiddenItem(state, id);
  }
  if (state.engine === 'insertion') {
    const inRanking =
      state.sorted.includes(id) || state.pending.includes(id);
    if (inRanking) {
      return insertion.returnToPending(insertion.unhideItem(state, id), id);
    }
    return insertion.restoreHiddenItem(state, id);
  }
  return merge.reinsertHiddenItem(state, id, options);
}

// ---------- completion normalization ----------

/**
 * A completed merge may keep its final ranking sublist, but it cannot keep
 * active merge/insert work. Detached insertion items from older saves are
 * treated as cancelled and moved to hidden.
 */
function reconcileDoneMergeState(state: MergeState): MergeState {
  if (!state.done) return state;

  const hasInFlightWork =
    state.queue.length > 1 ||
    state.current !== null ||
    state.currentManualInsert !== null ||
    state.currentAutoInsert !== null;
  if (hasInFlightWork) {
    return { ...state, done: false };
  }

  const detachedIds = [
    ...state.toBeInserted,
    ...state.pendingManualInserts,
  ];
  if (detachedIds.length === 0) return state;

  const hidden = new Set(state.hidden);
  const ranked = new Set(state.queue.flat());
  for (const id of detachedIds) {
    if (state.items[id] && !ranked.has(id)) hidden.add(id);
  }
  return {
    ...state,
    hidden: [...hidden].sort(),
    toBeInserted: [],
    pendingManualInserts: [],
  };
}

/**
 * Repair stale work buckets and contradictory done flags, then normalize
 * completed sorts when loading a save.
 */
export function normalizeLoadedState(
  loaded: SortState,
  options?: MergeOptions,
): SortState {
  const state = repairLoadedSection(loaded);
  let reconciled: SortState =
    state.engine === 'merge' ? reconcileDoneMergeState(state) : state;
  if (reconciled.engine === 'merge' && !reconciled.done) {
    reconciled = merge.reconcileStaleManualInserts(
      merge.reconcileInFlightInsertFrames(reconciled, options),
      options,
    );
  }
  if (reconciled.engine === 'merge') {
    reconciled = reconcileDoneMergeState(reconciled);
  }
  return finalizeCompletedState(reconciled);
}

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
  const completed = finalizeEngineCompletion(state);
  if (!completed.done || !completed.section || completed.engine !== 'merge') {
    return completed;
  }
  return spliceFinishedSection(completed);
}

/**
 * Drops the finished section back between its frozen neighbours:
 * `before + sorted section + tailPlaceholders + after`. Items hidden during
 * the re-sort end up hidden with no rank (via `reconcileDoneMergeState`).
 */
function spliceFinishedSection(state: MergeState): MergeState {
  const { section, ...rest } = state;
  if (!section) return state;
  const inner = reconcileDoneMergeState(rest);
  if (!inner.done) return { ...inner, section };
  const seen = new Set<ItemId>();
  const order: ItemId[] = [];
  const parts = [section.before, inner.queue[0] ?? [], section.tailPlaceholders, section.after];
  for (const id of parts.flat()) {
    if (seen.has(id) || !state.items[id]) continue;
    seen.add(id);
    order.push(id);
  }
  const hidden = inner.hidden.filter((id) => !!state.items[id]);
  const stillHidden = new Set(hidden);
  const exiled = [
    ...(section.originalToBeInserted ?? []).filter(
      (id) => stillHidden.has(id) && !seen.has(id),
    ),
    ...inner.toBeInserted,
  ];
  return {
    ...inner,
    queue: [order],
    hidden,
    toBeInserted: [...new Set(exiled)],
    comparisons: section.priorComparisons + inner.comparisons,
    totalComparisonsEverNeeded:
      section.priorTotalComparisonsEverNeeded + inner.totalComparisonsEverNeeded,
  };
}

const SECTION_ID_LISTS = [
  'before',
  'after',
  'tailPlaceholders',
  'originalOrder',
  'originalHidden',
] as const;

function isValidSectionShape(section: unknown): boolean {
  if (typeof section !== 'object' || section === null) return false;
  const s = section as Record<string, unknown>;
  const idLists = SECTION_ID_LISTS.every(
    (key) => Array.isArray(s[key]) && (s[key] as unknown[]).every((id) => typeof id === 'string'),
  );
  const numbers = (
    ['priorComparisons', 'priorTotalComparisonsEverNeeded', 'startRank', 'endRank'] as const
  ).every((key) => typeof s[key] === 'number' && Number.isFinite(s[key]));
  const exiled = s.originalToBeInserted;
  const exiledOk =
    exiled === undefined ||
    (Array.isArray(exiled) && exiled.every((id) => typeof id === 'string'));
  return idLists && numbers && exiledOk;
}

/**
 * A malformed section can't be spliced, so it falls back to the ranking from
 * before the re-sort when that part is readable; otherwise the section is
 * dropped. Frozen ids that also appear in the live section, or that no longer
 * have an item, are removed from the frozen parts so nothing is ranked twice.
 */
function repairLoadedSection(state: SortState): SortState {
  const raw = state.section as unknown;
  if (raw === undefined) return state;
  if (!isValidSectionShape(raw)) {
    const s = raw as Partial<SectionResortLike> | null;
    const order = s?.originalOrder;
    if (Array.isArray(order) && order.every((id) => typeof id === 'string')) {
      const hidden = Array.isArray(s?.originalHidden) ? s.originalHidden : [];
      return cancelSectionResort({
        ...state,
        section: {
          before: [],
          after: [],
          tailPlaceholders: [],
          originalOrder: order,
          originalHidden: hidden.filter((id): id is string => typeof id === 'string'),
          priorComparisons: typeof s?.priorComparisons === 'number' ? s.priorComparisons : state.comparisons,
          priorTotalComparisonsEverNeeded:
            typeof s?.priorTotalComparisonsEverNeeded === 'number'
              ? s.priorTotalComparisonsEverNeeded
              : state.totalComparisonsEverNeeded,
          startRank: 1,
          endRank: 1,
        },
      });
    }
    const { section: _drop, ...rest } = state;
    void _drop;
    return rest as SortState;
  }
  const section = state.section!;
  const { section: _ignore, ...engineOnly } = state;
  void _ignore;
  const live = activeRankingIds(engineOnly as SortProgress);
  const keep = (ids: ItemId[]): ItemId[] =>
    ids.filter((id) => !live.has(id) && !!state.items[id]);
  const before = keep(section.before);
  const after = keep(section.after);
  const tailPlaceholders = keep(section.tailPlaceholders);
  const unchanged =
    before.length === section.before.length &&
    after.length === section.after.length &&
    tailPlaceholders.length === section.tailPlaceholders.length;
  if (unchanged) return state;
  return { ...state, section: { ...section, before, after, tailPlaceholders } };
}

type SectionResortLike = NonNullable<SortProgress['section']>;

function finalizeEngineCompletion(state: SortState): SortState {
  if (!state.done || state.engine === 'merge') return state;
  const completedState =
    state.engine === 'insertion' ? insertion.reconcileDoneState(state) : state;
  if (!completedState.done) return completedState;
  const ranking =
    completedState.engine === 'insertion'
      ? completedState.sorted.slice()
      : completedState.confirmed.slice();
  const mergeState: MergeState = {
    engine: 'merge',
    queue: [ranking],
    current: null,
    comparisons: completedState.comparisons,
    done: true,
    hidden: completedState.hidden.slice(),
    totalComparisonsEverNeeded: completedState.totalComparisonsEverNeeded,
    toBeInserted: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
    ...sectionField(completedState.section),
    items: completedState.items,
  };
  return mergeState;
}
