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
  getSourceSyncMeta,
  patchSourceSyncMeta,
  recordSourceDbDirtyWrite,
} from '../../db/syncManifest';
import { ANILIST_SOURCE_ID } from './anilistSource';
import { findAnilistAccountByName, resolveAccessTokenForUsername } from './anilistAuth';
import { makeAnilistImportContext } from './context';
import { importAnilistFavourites } from './favourites';
import { importAnilistList } from './importer';
import { expandCharacterMedia, type ExpandCharacterMediaResult } from './expandCharacterMedia';
import { expandStaffFilmography, type ExpandStaffFilmographyResult } from './expandStaffFilmography';
import { expandMediaRelations, type ExpandMediaRelationsResult } from './expandMediaRelations';
import {
  expandAnilistMediaDetail,
  type ExpandAnilistMediaDetailResult,
  type ExpandAnilistMediaDetailOptions,
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
function buildContext(
  onProgress?: AnilistProgressReporter,
  auth?: { username: string },
) {
  const account = auth ? findAnilistAccountByName(auth.username) : null;
  const accessToken = auth ? resolveAccessTokenForUsername(auth.username) : null;
  return makeAnilistImportContext({
    onAutoPushRequested: async () => {
      if (hooks.onAutoPushRequested) await hooks.onAutoPushRequested();
    },
    onDirtyIncrement: async () => {
      const next = recordSourceDbDirtyWrite(ANILIST_SOURCE_ID);
      if (hooks.onDirtyBumped) hooks.onDirtyBumped(next);
    },
    onProgress,
    accessToken: accessToken ?? undefined,
    authFailureUserId: account?.userId,
  });
}

/**
 * Mark the source as having a local DB once any successful write
 * completes. This is what tells boot-time `pullDbFromDrive` whether the
 * tab already has data (skip the pull) or is empty (pull from Drive so
 * the user doesn't have to click anything). Previously `hasLocalDb` was
 * only set by push/pull — so a first-ever import on a device left it
 * `false` and the next tab open would trigger an unwanted pull-and-merge.
 * Idempotent: a noop write when the flag is already true.
 */
function markLocalDbPresent(): void {
  const meta = getSourceSyncMeta(ANILIST_SOURCE_ID);
  if (meta.hasLocalDb) return;
  patchSourceSyncMeta(ANILIST_SOURCE_ID, { hasLocalDb: true });
}

export async function runAnilistImport(
  username: string,
  type: AnilistMediaType,
  onProgress?: AnilistProgressReporter,
): Promise<ImportAnilistListResult> {
  const result = await importAnilistList(buildContext(onProgress, { username }), { username, type });
  markLocalDbPresent();
  return result;
}

export async function runAnilistFavourites(
  username: string,
  type: AnilistFavouriteType,
  onProgress?: AnilistProgressReporter,
): Promise<ImportAnilistFavouritesResult> {
  const result = await importAnilistFavourites(buildContext(onProgress), { username, type });
  markLocalDbPresent();
  return result;
}

export async function runAnilistMediaLazyExpansion(
  mediaId: number,
  onProgress?: AnilistProgressReporter,
  options?: ExpandAnilistMediaDetailOptions,
): Promise<ExpandAnilistMediaDetailResult | null> {
  const result = await expandAnilistMediaDetail(
    buildContext(onProgress),
    mediaId,
    options,
  );
  if (result) markLocalDbPresent();
  return result;
}

export async function runAnilistStaffFilmographyExpansion(
  staffId: number,
  onProgress?: AnilistProgressReporter,
): Promise<ExpandStaffFilmographyResult | null> {
  const result = await expandStaffFilmography(buildContext(onProgress), staffId);
  if (result) markLocalDbPresent();
  return result;
}

export async function runAnilistCharacterMediaExpansion(
  characterId: number,
  onProgress?: AnilistProgressReporter,
): Promise<ExpandCharacterMediaResult | null> {
  const result = await expandCharacterMedia(buildContext(onProgress), characterId);
  if (result) markLocalDbPresent();
  return result;
}

export async function runAnilistMediaRelationsExpansion(
  mediaId: number,
  onProgress?: AnilistProgressReporter,
): Promise<ExpandMediaRelationsResult | null> {
  const result = await expandMediaRelations(buildContext(onProgress), mediaId);
  if (result) markLocalDbPresent();
  return result;
}
