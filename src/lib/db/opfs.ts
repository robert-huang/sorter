export type StorageMode = 'opfs' | 'memory';

export const DB_NON_PERSISTENT_EVENT = 'db:non-persistent';

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

/** OPFS sync access handles (SAH pool) require cross-origin isolation. */
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
 * Pre-check before calling `installOpfsSAHPoolVfs` in the worker.
 * Mirrors sqlite-wasm's required OPFS APIs plus COOP/COEP for SAH.
 */
export function canUseOpfsSahPool(): boolean {
  return (
    isOpfsSecureContext() &&
    isCrossOriginIsolated() &&
    hasOpfsSyncAccessHandleApi() &&
    typeof navigator?.storage?.getDirectory === 'function'
  );
}

/** Human-readable reason when {@link canUseOpfsSahPool} is false (worker or page). */
export function describeOpfsBlockedReason(): string {
  if (!isOpfsSecureContext()) {
    return 'This page is not a secure context. Use https:// or http://localhost (not plain http on a LAN IP).';
  }
  if (!isCrossOriginIsolated()) {
    return (
      'OPFS persistence needs cross-origin isolation (COOP/COEP response headers). ' +
      'Use `npm run dev` / `npm run preview`, or serve `dist/` with COOP: same-origin and ' +
      'COEP: credentialless (see serve.json). GitHub Pages cannot set these headers.'
    );
  }
  if (!hasOpfsSyncAccessHandleApi()) {
    return 'This browser does not expose OPFS sync access handles (required for persistent SQLite).';
  }
  if (typeof navigator?.storage?.getDirectory !== 'function') {
    return 'navigator.storage.getDirectory is not available in this environment.';
  }
  return 'OPFS is not available in this environment.';
}

export function emitNonPersistentEvent(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(DB_NON_PERSISTENT_EVENT));
}
