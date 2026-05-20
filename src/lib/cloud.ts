/**
 * Cloud-backup tier 0b — provider-agnostic surface.
 *
 * This module is a thin proxy over a swappable `CloudProvider`
 * instance. The default provider is the Google Drive impl in
 * `cloud/googleDrive.ts`; tests can call `_setCloudProviderForTesting`
 * to substitute a mock and exercise the rest of the app without
 * touching the network.
 *
 * Provider methods are all async + safe to call from non-gesture
 * contexts (no popups, no `window.open`) — auth is done via a
 * same-window PKCE redirect, not a popup. The single exception is
 * `pickFolder`, which has to run the Google Picker SDK and requires a
 * user gesture for the popup; that constraint is part of the
 * interface contract.
 *
 * Storage shape (locked decision): one Drive file per slot. The
 * slot↔file binding is by the provider's file id, not by filename,
 * so a user-side rename in the provider's UI doesn't break the
 * binding (the file id is stable; the filename gets overridden on the
 * next Push because the app is the source of truth).
 *
 * The interface is "provider-agnostic" in the sense that a future
 * Dropbox / S3 / etc. impl could slot in here without redesign — the
 * `CloudProvider` interface is the contract. Multi-provider support
 * is deferred indefinitely (one provider keeps the implementation
 * surface honest).
 */

import type { AutosaveBlob } from './storage';

// Re-export the typed etag-mismatch error from the Drive impl so
// callers don't have to reach into the provider module. Pure value
// re-export — the error class is provider-agnostic, but lives next to
// the only code that throws it. If multi-provider lands later, hoist
// to its own file.
export { CloudEtagMismatchError } from './cloud/googleDrive';

// ---------- types ----------

/**
 * High-level auth state. `signed-in` means we have a valid access
 * token (or a refresh token we can use to silently get one) AND the
 * user has completed the post-sign-in folder pick. `signed-out` means
 * no tokens at all. `expired` means we had tokens but the refresh
 * token is gone or rejected — UI surfaces a one-shot "please sign in
 * again" banner on this state (Safari ITP path).
 *
 * `folderId` / `folderName` are only present when the user has
 * completed the folder pick. Until then, even after a successful
 * OAuth handshake the provider can't list / push / pull anything.
 *
 * `expiresAt` is the ms-epoch when the access token expires (refresh
 * is silent before this). Surfaced for debugging only.
 */
export interface AuthState {
  status: 'signed-in' | 'signed-out' | 'expired';
  expiresAt?: number;
  folderId?: string;
  folderName?: string;
}

/**
 * Per-slot metadata returned by `listCloudSlots`. Cheap shape — fits
 * in a single `files.list` round-trip with no payload bytes (Drive
 * lets us request `fields=files(id,name,modifiedTime,size,version,appProperties)`).
 *
 * `displayName` is the slot's human-readable name, sourced from the
 * file's `appProperties.sorterDisplayName` set at push time. Falls
 * back to parsing the filename for files predating the appProperties
 * stamp.
 *
 * `etag` is an opaque change-token string the provider stamps on
 * every change. For Drive it's `version.toString()` (Drive's
 * per-file monotonically-incrementing revision counter). Used by the
 * pre-Push stale-cache check — if the current etag differs from the
 * one local meta remembers from the last pull/push, the cloud copy
 * changed in between and we warn before clobbering.
 *
 * `sorterSlotId` is the local slot id stamped at push time, if
 * available. Lets the library UI hint "this cloud entry matches
 * your local slot X" vs "this would create a new local slot".
 */
export interface CloudSlotMeta {
  cloudId: string;
  displayName: string;
  filename: string;
  sizeBytes: number;
  updatedAt: string;
  etag: string;
  sorterSlotId?: string;
}

/** Result of a Pull: the inbound blob and the etag to remember. */
export interface CloudPullResult {
  blob: AutosaveBlob;
  etag: string;
  updatedAt: string;
  sorterSlotId?: string;
}

/** Result of a Push: the (possibly-new) cloud id and the new etag. */
export interface CloudPushResult {
  cloudId: string;
  etag: string;
  updatedAt: string;
}

/** Options bundle for Push. `desiredFilename` is sent on every push
 *  so a local rename naturally syncs (and a Drive-side rename gets
 *  overridden — locked decision: app is source of truth for names). */
export interface CloudPushOptions {
  desiredFilename: string;
  sorterSlotId: string;
  displayName: string;
  /** When set, the upload uses an If-Match precondition so the
   *  request fails if the server's etag differs. Phase 2 uses this
   *  for the stale-cache warning flow (first the warning, then on
   *  user confirm a forced push without the precondition). */
  expectedEtag?: string;
}

/** Listener fired on every auth state transition. The current state
 *  is passed by value so subscribers don't have to call `getAuthState`
 *  themselves. */
export type AuthListener = (state: AuthState) => void;

/**
 * Provider contract. Cloud providers implement this interface; the
 * module-level proxy below delegates to whichever provider is
 * currently active.
 *
 * Naming convention: the verbs match the proxy exports so the public
 * surface is one-to-one with the interface.
 */
export interface CloudProvider {
  /** Initiate a same-window PKCE redirect. Resolves *before* the
   *  redirect fires (the rest of the work happens after the round-trip
   *  via `handleAuthRedirect`). Must save any in-flight URL hash to
   *  sessionStorage so the redirect doesn't lose mid-import
   *  `#share=...` payloads. */
  signIn(): Promise<void>;

  /** Called once at boot if the URL carries auth-redirect params.
   *  Exchanges the code for tokens, persists them, and cleans up the
   *  URL (so a refresh doesn't replay the exchange). Restores any
   *  pre-auth hash that `signIn` stashed. Returns the new auth state
   *  (typically `signed-in` with no folder yet on first auth). */
  handleAuthRedirect(): Promise<AuthState>;

  /** Wipe tokens AND the folder selection so the next sign-in starts
   *  fresh. The locked-decision rationale: folder-pick is part of the
   *  per-account state, so sign-out is a clean slate. */
  signOut(): Promise<void>;

  getAuthState(): AuthState;

  /** Refresh the access token if it's near expiry. Idempotent. On
   *  refresh-token failure (revoked / expired) transitions to
   *  `expired` state and resolves — the UI surfaces the
   *  please-sign-in-again banner on the next `getAuthState`. */
  refreshTokenIfNeeded(): Promise<void>;

  /** Open the provider's folder picker. MUST be invoked from a user
   *  gesture (popup blockers will eat it otherwise). Persists the pick
   *  on success and returns the chosen folder's id + display name. */
  pickFolder(): Promise<{ folderId: string; folderName: string }>;

  /** Hint that the user wants to leave the current folder selection.
   *  No-op for providers that don't have a notion of a "current
   *  folder" (would be relevant if we ever add multi-provider). */
  clearFolder(): Promise<void>;

  /** Subscribe to auth state changes. Fires whenever the result of
   *  `getAuthState()` would change (post-signIn, post-folder-pick,
   *  post-signOut, post-token-expiry). */
  subscribeAuthChange(listener: AuthListener): () => void;

  /** List every slot file in the user's chosen folder. Metadata-only,
   *  no payload bytes. Returns empty when no folder is picked yet. */
  listCloudSlots(): Promise<CloudSlotMeta[]>;

  /** Download a single slot file's full contents. */
  pullSlot(cloudId: string): Promise<CloudPullResult>;

  /** Upload a slot's blob. `cloudId === null` creates a new file under
   *  the chosen folder; a string id targets an existing file by id.
   *  On a stale-id 404 (file was deleted in the provider UI), the
   *  provider impl handles the fallback (clear binding + create-new
   *  + surface a recovery indicator on the result). */
  pushSlot(
    cloudId: string | null,
    blob: AutosaveBlob,
    opts: CloudPushOptions,
  ): Promise<CloudPushResult>;

  /** Hard-delete a slot's cloud blob. No-op + resolves on 404 (the
   *  file's already gone, which is the desired end state). */
  removeCloudSlot(cloudId: string): Promise<void>;
}

// ---------- active provider (swappable for tests) ----------

let activeProvider: CloudProvider | null = null;
/** Lazy default-provider factory. Stored as a function so importing
 *  `cloud.ts` doesn't trigger `googleDrive.ts` side effects until a
 *  real call comes in — keeps tests that fully mock the provider
 *  from accidentally executing the real impl's module-level code. */
let defaultProviderFactory: (() => CloudProvider) | null = null;

/**
 * Register the factory that produces the production provider. Called
 * once at app boot (in `App.tsx`) so the proxy can lazily instantiate
 * on first use. Tests skip this and use `_setCloudProviderForTesting`
 * instead.
 */
export function registerDefaultCloudProvider(factory: () => CloudProvider): void {
  defaultProviderFactory = factory;
}

function getProvider(): CloudProvider {
  if (activeProvider) return activeProvider;
  if (!defaultProviderFactory) {
    throw new Error(
      'No cloud provider registered. Call registerDefaultCloudProvider at boot ' +
        'or _setCloudProviderForTesting in tests before calling cloud APIs.',
    );
  }
  activeProvider = defaultProviderFactory();
  return activeProvider;
}

/** Test-only: substitute a mock provider. Clears any previously-cached
 *  provider so the next call goes through the mock. */
export function _setCloudProviderForTesting(p: CloudProvider | null): void {
  activeProvider = p;
}

/** Test-only: reset both the active provider and the default factory.
 *  Call between test cases to avoid one suite's factory leaking into
 *  another's. */
export function _resetCloudProviderForTesting(): void {
  activeProvider = null;
  defaultProviderFactory = null;
}

// ---------- proxy surface ----------

export function signIn(): Promise<void> {
  return getProvider().signIn();
}

export function handleAuthRedirect(): Promise<AuthState> {
  return getProvider().handleAuthRedirect();
}

export function signOut(): Promise<void> {
  return getProvider().signOut();
}

export function getAuthState(): AuthState {
  // Defensive: if no provider is registered yet (e.g. very early boot
  // before App.tsx wires the factory), return signed-out rather than
  // throwing. Lets the gear menu render its "Sign in to cloud" entry
  // without waiting on the factory registration.
  if (!activeProvider && !defaultProviderFactory) {
    return { status: 'signed-out' };
  }
  return getProvider().getAuthState();
}

export function refreshTokenIfNeeded(): Promise<void> {
  return getProvider().refreshTokenIfNeeded();
}

export function pickFolder(): Promise<{ folderId: string; folderName: string }> {
  return getProvider().pickFolder();
}

export function clearFolder(): Promise<void> {
  return getProvider().clearFolder();
}

export function subscribeAuthChange(listener: AuthListener): () => void {
  return getProvider().subscribeAuthChange(listener);
}

export function listCloudSlots(): Promise<CloudSlotMeta[]> {
  return getProvider().listCloudSlots();
}

export function pullSlot(cloudId: string): Promise<CloudPullResult> {
  return getProvider().pullSlot(cloudId);
}

export function pushSlot(
  cloudId: string | null,
  blob: AutosaveBlob,
  opts: CloudPushOptions,
): Promise<CloudPushResult> {
  return getProvider().pushSlot(cloudId, blob, opts);
}

export function removeCloudSlot(cloudId: string): Promise<void> {
  return getProvider().removeCloudSlot(cloudId);
}

// ---------- filename convention ----------

/**
 * Build the canonical Drive filename for a slot:
 *   `<slotName>_<slotId>.sorter.json`
 *
 * The slot id suffix guarantees no filename collisions even if two
 * slots share the same name; the slot-name prefix keeps the Drive UI
 * readable (the user can recognize "Movies_a3kp9q2.sorter.json" at a
 * glance).
 *
 * Slot names can contain arbitrary characters that aren't legal in
 * filenames on some filesystems (Drive itself is permissive but local
 * downloads might land on FAT32 / NTFS). Sanitize aggressively:
 *  - replace runs of disallowed chars with a single underscore
 *  - collapse multiple underscores
 *  - trim leading/trailing underscores
 *  - cap to a reasonable length (Drive's hard limit is 32KB; 80 chars
 *    keeps things readable in the Drive UI list view).
 * The slot id is appended AFTER sanitization so it can't be eaten.
 */
export function buildSlotFilename(slotName: string, slotId: string): string {
  const cleaned = slotName
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const safeName = cleaned.length > 0 ? cleaned : 'Untitled';
  return `${safeName}_${slotId}.sorter.json`;
}

/**
 * Best-effort recovery of the slot's display name from a filename, for
 * cloud files that predate the `appProperties.sorterDisplayName`
 * stamp. Mirrors `buildSlotFilename`'s shape: everything up to the
 * final `_<id>.sorter.json` suffix is the display name. Returns the
 * full filename verbatim when the suffix is missing.
 */
export function parseDisplayNameFromFilename(filename: string): string {
  // Strip the `.sorter.json` extension first, then everything after
  // the last underscore (the id). What's left is the display name.
  const withoutExt = filename.replace(/\.sorter\.json$/i, '');
  const lastUnderscore = withoutExt.lastIndexOf('_');
  if (lastUnderscore <= 0) return withoutExt;
  return withoutExt.slice(0, lastUnderscore);
}
