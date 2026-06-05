export type StorageMode = 'opfs' | 'memory';

export type DbNonPersistentReason = 'other_tab' | 'opfs_unavailable';

export type DbNonPersistentEventDetail = {
  reason: DbNonPersistentReason;
};

export const DB_NON_PERSISTENT_EVENT = 'db:non-persistent';

export type DbStorageBannerContext = 'sorter' | 'a2a';

/** User-facing copy when this tab fell back to in-memory SQLite. */
export function describeNonPersistentStorageBanner(options: {
  reason: DbNonPersistentReason;
  storageHint?: string;
  context: DbStorageBannerContext;
}): string {
  const { reason, storageHint, context } = options;

  if (reason === 'other_tab') {
    return context === 'a2a'
      ? 'Another Sorter tab has the database open. Close it and reload this page to use your AniList cache.'
      : 'Another tab of this app has the database open. Close other Sorter / Anime to Anime tabs and reload to use your saved cache.';
  }

  if (context === 'a2a') {
    return (
      'This tab is using in-memory storage — your AniList cache is not available here.' +
      (storageHint ? ` ${storageHint}` : '')
    );
  }

  return (
    'This tab is using non-persistent storage (OPFS unavailable in this browser or environment). ' +
    'Changes here may not persist across reloads.' +
    (storageHint ? ` ${storageHint}` : '') +
    ' Pull from Drive (gear → Source databases → Pull) to load data for this session.'
  );
}

/**
 * Whether this JS realm can use OPFS-backed persistence (secure context).
 * Actual OPFS availability still requires a successful SAH-Pool VFS install in the worker.
 */
export function isOpfsSecureContext(): boolean {
  if (typeof globalThis === 'undefined') {
    return false;
  }
  return globalThis.isSecureContext === true;
}

/** Whether the page is cross-origin isolated (COOP/COEP). Not required for OPFS SAH pool. */
export function isCrossOriginIsolated(): boolean {
  return globalThis.crossOriginIsolated === true;
}

export function hasOpfsSyncAccessHandleApi(): boolean {
  const proto = globalThis.FileSystemFileHandle?.prototype as
    | { createSyncAccessHandle?: unknown }
    | undefined;
  return typeof proto?.createSyncAccessHandle === 'function';
}

/**
 * Pre-check before calling `installOpfsSAHPoolVfs` in a dedicated worker.
 * Requires secure context and OPFS sync-access-handle APIs (not COOP/COEP).
 */
export function canUseOpfsSahPool(): boolean {
  return (
    isOpfsSecureContext() &&
    hasOpfsSyncAccessHandleApi() &&
    typeof navigator?.storage?.getDirectory === 'function'
  );
}

/** Human-readable reason when {@link canUseOpfsSahPool} is false (worker or page). */
export function describeOpfsBlockedReason(): string {
  if (!isOpfsSecureContext()) {
    return 'This page is not a secure context. Use https:// or http://localhost (not plain http on a LAN IP).';
  }
  if (!hasOpfsSyncAccessHandleApi()) {
    return 'This browser does not expose OPFS sync access handles (required for persistent SQLite).';
  }
  if (typeof navigator?.storage?.getDirectory !== 'function') {
    return 'navigator.storage.getDirectory is not available in this environment.';
  }
  return 'OPFS is not available in this environment.';
}

export function emitNonPersistentEvent(reason: DbNonPersistentReason): void {
  if (typeof window === 'undefined') {
    return;
  }
  const detail: DbNonPersistentEventDetail = { reason };
  window.dispatchEvent(new CustomEvent(DB_NON_PERSISTENT_EVENT, { detail }));
}
