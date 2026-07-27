import { getCompareProgress, type EngineOptions } from './engine';
import type { SortState } from './types';

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
