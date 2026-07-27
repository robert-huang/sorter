import { getCompareProgress, type EngineOptions } from './engine';
import type { SortState } from './types';

/**
 * Defer the title mutation to the next browser frame. Chromium on Windows
 * can update the DOM title without repainting the tab label when the
 * mutation lands before its tab-strip render.
 */
export function scheduleDocumentTitle(title: string): () => void {
  const frameId = window.requestAnimationFrame(() => {
    document.title = title;
  });
  return () => window.cancelAnimationFrame(frameId);
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
