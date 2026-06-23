import { makeAnilistImportContext, type AnilistImportContext } from './context';

let toolsCtx: AnilistImportContext | null = null;

/** Shared import context for Tools DB-first reads (worker-mediated SQLite). */
export function getToolsImportContext(): AnilistImportContext {
  if (!toolsCtx) {
    toolsCtx = makeAnilistImportContext();
  }
  return toolsCtx;
}

/** Test-only: reset singleton between cases. */
export function _resetToolsImportContextForTesting(): void {
  toolsCtx = null;
}
