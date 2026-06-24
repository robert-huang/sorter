import { recordSourceDbDirtyWrite } from '../../db/syncManifest';
import { ANILIST_SOURCE_ID } from './anilistSource';
import { makeAnilistImportContext, type AnilistImportContext } from './context';

let toolsCtx: AnilistImportContext | null = null;
let onDirtyBumped: ((newCount: number) => void) | undefined;

/**
 * Wire dirty-bump UI refresh for Tools graph expansion writes.
 * Called from ToolsApp on mount (mirrors `configureAnilistRunnerHooks`).
 */
export function configureToolsImportDirtyHook(
  next: { onDirtyBumped?: (newCount: number) => void } = {},
): void {
  onDirtyBumped = next.onDirtyBumped;
  toolsCtx = null;
}

function buildToolsImportContext(): AnilistImportContext {
  return makeAnilistImportContext({
    onDirtyIncrement: async () => {
      const next = recordSourceDbDirtyWrite(ANILIST_SOURCE_ID);
      if (onDirtyBumped) {
        onDirtyBumped(next);
      }
    },
  });
}

/** Shared import context for Tools DB-first reads (worker-mediated SQLite). */
export function getToolsImportContext(): AnilistImportContext {
  if (!toolsCtx) {
    toolsCtx = buildToolsImportContext();
  }
  return toolsCtx;
}

/** Test-only: reset singleton between cases. */
export function _resetToolsImportContextForTesting(): void {
  toolsCtx = null;
  onDirtyBumped = undefined;
}
