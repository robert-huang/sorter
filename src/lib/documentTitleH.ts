import { getCompareProgress, type EngineOptions } from './engine';
import type { SortState } from './types';

/**
 * Defer the title mutation to the next browser frame. Chromium on Windows
 * can update the DOM title without repainting the tab label when the
 * mutation lands before its tab-strip render.
 */
export function scheduleDocumentTitle(title: string): () => void {
  const frameId = window.requestAnimationFrame(() => {
    // Chromium can retain a stale tab-strip label even though the DOM already
    // contains `title`. Force a real mutation when reasserting the same value.
    if (document.title === title) {
      document.title = '';
    }
    document.title = title;
  });
  return () => window.cancelAnimationFrame(frameId);
}

/**
 * Browser tab title for the active sort session. Matches CompareScreen
 * progress semantics: `done` shows ✓, in-progress shows forecast %, and
 * a loaded slot with no work yet omits the percent. The slot name leads
 * so parallel sorter tabs remain distinguishable at a glance.
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
