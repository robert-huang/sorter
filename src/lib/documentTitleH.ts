import { getCompareProgress, type EngineOptions } from './engine';
import type { SortState } from './types';

/**
 * Pick path can commit `done` on the held ref before React state flushes.
 * Committed state wins once it is done so the tab title stays aligned with
 * the header ("Done · N comparisons").
 */
export function resolveDocumentTitleState(
  candidate: SortState | null,
  committed: SortState | null,
): SortState | null {
  if (committed?.done) return committed;
  if (candidate?.done) return candidate;
  return committed ?? candidate;
}

/**
 * Whether React's committed sort state should replace the held title
 * state. Blocks the one-comparison-behind stale render that can appear
 * between `applyPendingPick` (ref already done) and `setState` flush.
 */
export function shouldAdvanceTitleState(
  committed: SortState | null,
  held: SortState | null,
): boolean {
  if (committed === held) return false;
  if (!held) return committed !== null;
  if (!committed) return true;
  if (
    held.done &&
    !committed.done &&
    committed.comparisons === held.comparisons - 1
  ) {
    return false;
  }
  return true;
}

/**
 * Browser tab title for the active sort session. Matches CompareScreen
 * progress semantics: `done` shows ✓, in-progress shows forecast %, and
 * a loaded slot with no work yet omits the percent.
 */
export function formatDocumentTitle(
  nextState: SortState | null,
  slotName: string | undefined,
  options?: EngineOptions,
): string {
  if (!nextState) {
    return 'Sorter';
  }
  const base = slotName ?? 'Untitled sort';
  if (nextState.done) {
    return `${base} ✓ — Sorter`;
  }
  const { total, pct } = getCompareProgress(nextState, options);
  if (total === 0) {
    return `${base} — Sorter`;
  }
  return `${base} (${pct}%) — Sorter`;
}
