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

export function emitNonPersistentEvent(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(DB_NON_PERSISTENT_EVENT));
}
