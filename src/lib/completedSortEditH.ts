import {
  addItem as engineAddItem,
  addItems as engineAddItems,
  transitionMergeDoneToInsertion,
  type EngineOptions,
} from './engine';
import {
  resetBranchedComparisonProgress as resetInsertionBranchedComparisonProgress,
} from './insertionSort';
import {
  appendPreRankedSublist,
  resetBranchedComparisonProgress as resetMergeBranchedComparisonProgress,
} from './queueMergeSort';
import type { Item, ItemId, SortState } from './types';

/** What the user is trying to do to a completed (`done`) sort. */
export type CompletedSortEditAction =
  | { kind: 'appendPreRanked'; items: Item[] }
  | { kind: 'mergeToInsertion'; items: Item[] }
  | { kind: 'addOne'; item: Item }
  | { kind: 'addMany'; items: Item[] };

export function completedSortEditItemCount(action: CompletedSortEditAction): number {
  switch (action.kind) {
    case 'addOne':
      return 1;
    default:
      return action.items.length;
  }
}

/** Deep-clone sort state for minting a new slot without touching the original. */
export function cloneSortState(state: SortState): SortState {
  return JSON.parse(JSON.stringify(state)) as SortState;
}

/** Suffixes we recognize when branching again from an already-derived slot. */
const DERIVED_SLOT_SUFFIXES = [' (new)', ' (continued)', ' (redo)'] as const;

/**
 * - `branch` — add items / continue a completed ranking in a new slot
 * - `redo`   — Start over: fresh merge from the same item set
 */
export type DerivedSlotNameKind = 'branch' | 'redo';

const DERIVED_SLOT_SUFFIX: Record<DerivedSlotNameKind, string> = {
  branch: ' (new)',
  redo: ' (redo)',
};

/**
 * Name for a slot minted from an existing one. Strips a prior derived suffix
 * so "My list (new)" + branch → "My list (new)", not "My list (new) (new)".
 */
export function derivedSlotName(
  baseName: string,
  kind: DerivedSlotNameKind,
): string {
  let stem = baseName.trim();
  for (const existing of DERIVED_SLOT_SUFFIXES) {
    if (stem.endsWith(existing)) {
      stem = stem.slice(0, -existing.length);
      break;
    }
  }
  const suffix = DERIVED_SLOT_SUFFIX[kind];
  const max = 120;
  if (stem.length + suffix.length <= max) {
    return `${stem}${suffix}`;
  }
  return `${stem.slice(0, max - suffix.length)}${suffix}`;
}

/** @deprecated Use derivedSlotName(base, 'branch') */
export function continuedSlotName(baseName: string): string {
  return derivedSlotName(baseName, 'branch');
}

export interface ApplyCompletedSortEditResult {
  state: SortState;
  skipped: ItemId[];
  /** True when the sort was done before and is in-progress after the edit. */
  resumed: boolean;
}

/**
 * Apply an edit to a sort snapshot. Caller owns undo / slot minting.
 */
export function applyCompletedSortEdit(
  base: SortState,
  action: CompletedSortEditAction,
  options: EngineOptions,
): ApplyCompletedSortEditResult {
  const wasDone = base.done;
  let skipped: ItemId[] = [];
  let next: SortState = base;

  switch (action.kind) {
    case 'appendPreRanked': {
      if (base.engine !== 'merge') {
        return { state: base, skipped: [], resumed: false };
      }
      const result = appendPreRankedSublist(base, action.items, options);
      next = result.state;
      skipped = result.skipped;
      break;
    }
    case 'mergeToInsertion': {
      if (base.engine !== 'merge' || !base.done) {
        return { state: base, skipped: [], resumed: false };
      }
      const result = transitionMergeDoneToInsertion(base, action.items);
      next = result.state;
      skipped = result.skipped;
      break;
    }
    case 'addOne': {
      const added = engineAddItem(base, action.item, options);
      if (added === null) {
        // Duplicate id — same contract as addMany / appendPreRanked so the
        // UI can flash "already in the sort" instead of failing silently.
        return { state: base, skipped: [action.item.id], resumed: false };
      }
      next = added;
      break;
    }
    case 'addMany': {
      const result = engineAddItems(base, action.items, options);
      next = result.state;
      skipped = result.skipped;
      break;
    }
  }

  const resumed = wasDone && !next.done;
  return { state: next, skipped, resumed };
}

/**
 * Reset comparison counter / budget for a slot minted from a completed sort.
 * In-place edits on the same slot must not call this.
 */
export function resetBranchedSlotComparisonProgress(
  state: SortState,
  options: EngineOptions,
): SortState {
  if (state.engine === 'merge') {
    return resetMergeBranchedComparisonProgress(state, options);
  }
  if (state.engine === 'insertion') {
    return resetInsertionBranchedComparisonProgress(state);
  }
  return state;
}
