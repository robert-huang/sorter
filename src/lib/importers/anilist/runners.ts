/**
 * App-level runner facade. The UI layer (StartScreen anilist mode,
 * AnilistSourcePanel, AnilistDetailModal) reaches for these — not the
 * raw importers — so the autopush / dirty-bump / scrape-lock-error
 * surfacing is wired in exactly one place.
 *
 * Why a separate module rather than inline in App.tsx:
 *   - App.tsx already passes ~30 props down to SettingsMenu; adding
 *     three more context-bound functions would compound the noise.
 *   - These runners need to be callable from inside the StartScreen
 *     "anilist" mode tab content WITHOUT prop-drilling them past every
 *     intermediate component. Importing from a module is cleaner than
 *     adding more props.
 *   - Tests can drop in `__setRunnerHooksForTesting` to swap the
 *     autopush + dirty-bump hooks without spinning up the whole App.
 *
 * Production hooks:
 *   - autopush -> calls App.tsx's onDbPushSource('anilist') iff cloud
 *     ready (App wires this via `configureAnilistRunnerHooks`).
 *   - dirtyBump -> bumps the syncManifest pendingChanges counter and
 *     fires the App's dbSyncRevision bump so the UI refreshes labels.
 */

import {
  bumpPendingChanges,
} from '../../db/syncManifest';
import { ANILIST_SOURCE_ID } from './anilistSource';
import { makeAnilistImportContext } from './context';
import { importAnilistFavourites } from './favourites';
import { importAnilistList } from './importer';
import {
  expandAnilistMediaDetail,
  type ExpandAnilistMediaDetailResult,
} from './lazyExpansion';
import type { AnilistProgressReporter } from './progress';
import type {
  AnilistFavouriteType,
  AnilistMediaType,
} from './types';
import type { ImportAnilistListResult } from './importer';
import type { ImportAnilistFavouritesResult } from './favourites';

export interface AnilistRunnerHooks {
  /**
   * Called after a successful import/favourites refresh. Production
   * wiring delegates to App.tsx's onDbPushSource('anilist') — that
   * already gates on `cloudStatus === 'ready'` so the hook is safe
   * to call regardless of cloud auth state.
   */
  onAutoPushRequested?: () => Promise<void> | void;
  /**
   * Called after every per-entry lazy expansion. Default wiring
   * bumps the pending-changes counter; production wiring also
   * triggers App.tsx's dbSyncRevision bump so the source panel
   * picks up the new value.
   */
  onDirtyBumped?: (newCount: number) => void;
}

let hooks: AnilistRunnerHooks = {};

/**
 * Configure the runner hooks. Called once by App.tsx on mount; safe to
 * call again to swap hooks (tests or hot-reload). Subsequent calls
 * REPLACE rather than merge — the App holds the canonical set.
 */
export function configureAnilistRunnerHooks(next: AnilistRunnerHooks): void {
  hooks = next;
}

/** Build a fresh import context with hooks bound at call-time so a
 *  hook change between import start and completion is honoured. The
 *  per-call `onProgress` is passed in by the UI caller — runner
 *  hooks deliberately don't carry it because progress is highly
 *  caller-scoped (one input box / one button needs the labels). */
function buildContext(onProgress?: AnilistProgressReporter) {
  return makeAnilistImportContext({
    onAutoPushRequested: async () => {
      if (hooks.onAutoPushRequested) await hooks.onAutoPushRequested();
    },
    onDirtyIncrement: async () => {
      // bumpPendingChanges is synchronous (localStorage write); the
      // async wrapper here keeps the hook contract uniform so the
      // App-side hook (which schedules React state updates) can stay
      // async if it ever needs to.
      const next = bumpPendingChanges(ANILIST_SOURCE_ID);
      if (hooks.onDirtyBumped) hooks.onDirtyBumped(next);
    },
    onProgress,
  });
}

export async function runAnilistImport(
  username: string,
  type: AnilistMediaType,
  onProgress?: AnilistProgressReporter,
): Promise<ImportAnilistListResult> {
  return importAnilistList(buildContext(onProgress), { username, type });
}

export async function runAnilistFavourites(
  username: string,
  type: AnilistFavouriteType,
  onProgress?: AnilistProgressReporter,
): Promise<ImportAnilistFavouritesResult> {
  return importAnilistFavourites(buildContext(onProgress), { username, type });
}

export async function runAnilistMediaLazyExpansion(
  mediaId: number,
  onProgress?: AnilistProgressReporter,
): Promise<ExpandAnilistMediaDetailResult | null> {
  return expandAnilistMediaDetail(buildContext(onProgress), mediaId);
}
