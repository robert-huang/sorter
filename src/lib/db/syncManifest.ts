// TODO: "Remove this source's local data" UX is not implemented. When added,
// it needs:
//   1. sahPool.unlink(`/${sourceId}.sqlite`) in the worker to free the OPFS
//      slot (memory mode: closeDb + the in-memory file is GC'd).
//   2. A removeSourceSyncMeta(sourceId) helper here that deletes the manifest
//      entry so a future sync starts clean (hasLocalDb=false,
//      remoteEtag=null, etc.).
//   3. Optional: deleteSourceDb(sourceId) in cloud/googleDrive.ts to remove
//      the Drive blob (the user should be asked separately whether to also
//      delete the cloud copy).
// Surface as a destructive "Remove" button in sourceDatabasesSection.tsx with
// a confirm.

/**
 * Per-source scrape-in-progress lock. Coordinates concurrent imports across
 * tabs in the same browser profile (localStorage is shared). The token is
 * an opaque per-acquisition string so a tab can only release / refresh a
 * lock that it itself acquired — guards against tab B clobbering tab A's
 * in-flight scrape if the same release path runs twice.
 */
export type ScrapeLock = {
  token: string;
  /** Epoch-ms when the lock was first acquired. */
  heldSince: number;
  /**
   * Epoch-ms of the most recent refresh — bumped by the importer as it
   * makes meaningful progress (e.g. after each page write). Lock becomes
   * stale (and acquirable by another tab) when `now - lastActivity` exceeds
   * {@link SCRAPE_LOCK_STALE_MS}.
   */
  lastActivity: number;
};

/** Stale-timeout in ms. After this, another tab can take over the lock. */
export const SCRAPE_LOCK_STALE_MS = 5 * 60 * 1000;

/** Per-source Drive sync metadata (separate from slot autosave manifest). */
export type SourceSyncMeta = {
  remoteEtag: string | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  remoteFileId: string | null;
  /** True after this device has a local OPFS/memory DB for the source. */
  hasLocalDb: boolean;
  /** Set when a push detects remote etag changed without a pull since. */
  driftDetected: boolean;
  /**
   * Active scrape lock, or `null` when no scrape is in progress. Cleared by
   * {@link releaseScrapeLock}; a stale lock (older than
   * {@link SCRAPE_LOCK_STALE_MS}) is treated as cleared by
   * {@link acquireScrapeLock} so a crashed-tab lock never wedges the source.
   */
  scrapeLock: ScrapeLock | null;
};

export type DbSyncManifest = {
  sources: Record<string, SourceSyncMeta>;
};

const SYNC_MANIFEST_KEY = 'sorter:db-sync:v1';

function emptyMeta(): SourceSyncMeta {
  return {
    remoteEtag: null,
    lastPushAt: null,
    lastPullAt: null,
    remoteFileId: null,
    hasLocalDb: false,
    driftDetected: false,
    scrapeLock: null,
  };
}

export function readDbSyncManifest(): DbSyncManifest {
  try {
    const raw = localStorage.getItem(SYNC_MANIFEST_KEY);
    if (!raw) {
      return { sources: {} };
    }
    const parsed = JSON.parse(raw) as Partial<DbSyncManifest>;
    if (!parsed.sources || typeof parsed.sources !== 'object') {
      return { sources: {} };
    }
    return { sources: parsed.sources };
  } catch {
    return { sources: {} };
  }
}

export function writeDbSyncManifest(manifest: DbSyncManifest): void {
  try {
    localStorage.setItem(SYNC_MANIFEST_KEY, JSON.stringify(manifest));
  } catch {
    /* ignore quota errors */
  }
}

export function getSourceSyncMeta(sourceId: string): SourceSyncMeta {
  const manifest = readDbSyncManifest();
  const stored = manifest.sources[sourceId];
  if (!stored) {
    return emptyMeta();
  }
  // Manifests persisted before the scrape-lock field was added are missing
  // `scrapeLock`; default-fill so callers can assume the field is always
  // defined (`null` = no active lock).
  return { ...emptyMeta(), ...stored };
}

export function patchSourceSyncMeta(
  sourceId: string,
  patch: Partial<SourceSyncMeta>,
): SourceSyncMeta {
  const manifest = readDbSyncManifest();
  const prev = manifest.sources[sourceId] ?? emptyMeta();
  const next = { ...prev, ...patch };
  manifest.sources[sourceId] = next;
  writeDbSyncManifest(manifest);
  return next;
}

/** Test-only reset. */
export function _clearDbSyncManifestForTesting(): void {
  try {
    localStorage.removeItem(SYNC_MANIFEST_KEY);
  } catch {
    /* ignore */
  }
}

// ──────────────────────────────────────────────────────────────────────
// Scrape-lock primitives
//
// Used by source importers (anilist + any future source) to coordinate
// concurrent scrapes across tabs. Persisted inside SourceSyncMeta so the
// lock state survives reloads — important because a tab that crashed mid-
// import leaves a lock behind, and the stale timeout is the only thing
// freeing it without user action.
// ──────────────────────────────────────────────────────────────────────

function isLockStale(lock: ScrapeLock, now: number): boolean {
  return now - lock.lastActivity >= SCRAPE_LOCK_STALE_MS;
}

function newToken(): string {
  // Random-enough for the cross-tab coordination case; not used for any
  // security boundary. crypto.randomUUID is widely available in browsers
  // and jsdom, but fall back to a Math.random-derived hex string for
  // ancient envs just in case.
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Acquire a scrape lock for `sourceId`. Returns `{ token }` if the caller
 * now holds the lock (either it was free or the previous lock was stale),
 * or `null` if another tab holds a fresh lock.
 *
 * The token must be passed to {@link refreshScrapeLock} and
 * {@link releaseScrapeLock} so the caller can prove ownership.
 */
export function acquireScrapeLock(
  sourceId: string,
  now: number = Date.now(),
): { token: string } | null {
  const existing = getSourceSyncMeta(sourceId).scrapeLock;
  if (existing && !isLockStale(existing, now)) {
    return null;
  }
  const lock: ScrapeLock = {
    token: newToken(),
    heldSince: now,
    lastActivity: now,
  };
  patchSourceSyncMeta(sourceId, { scrapeLock: lock });
  return { token: lock.token };
}

/**
 * Bump `lastActivity` so a long-running scrape doesn't get its lock
 * considered stale by another tab. Returns `true` if the refresh applied
 * (caller still owns the lock), `false` if the lock has been replaced
 * (another tab has it) or released.
 *
 * Importer convention: call after each meaningful step (e.g. each page
 * write) so the stale timeout protects against silent hangs but not
 * against normal in-flight work.
 */
export function refreshScrapeLock(
  sourceId: string,
  token: string,
  now: number = Date.now(),
): boolean {
  const existing = getSourceSyncMeta(sourceId).scrapeLock;
  if (!existing || existing.token !== token) {
    return false;
  }
  patchSourceSyncMeta(sourceId, {
    scrapeLock: { ...existing, lastActivity: now },
  });
  return true;
}

/**
 * Release the lock if-and-only-if the caller still owns it (token match).
 * No-op if the lock has been replaced or already released, so callers can
 * always call this in a `finally` block without checking ownership.
 */
export function releaseScrapeLock(sourceId: string, token: string): void {
  const existing = getSourceSyncMeta(sourceId).scrapeLock;
  if (!existing || existing.token !== token) {
    return;
  }
  patchSourceSyncMeta(sourceId, { scrapeLock: null });
}
