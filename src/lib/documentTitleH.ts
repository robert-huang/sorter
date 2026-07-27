import { getCompareProgress, type EngineOptions } from './engine';
import type { SortState } from './types';

/**
 * Pick which sort state should drive the tab title. Blocks stale
 * candidates (e.g. a debounced autosave manifest refresh landing after
 * Resume) from rewinding a further-along or completed in-memory session.
 */
export function pickDocumentTitleState(
  candidate: SortState | null,
  committed: SortState | null,
  acceptBackwardTransition = false,
): SortState | null {
  if (acceptBackwardTransition) return candidate;
  if (!committed) return candidate;
  if (!candidate) return committed;
  if (committed.done && !candidate.done) return committed;
  if (candidate.comparisons < committed.comparisons) return committed;
  return candidate;
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
