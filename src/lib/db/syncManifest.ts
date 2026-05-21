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
  return manifest.sources[sourceId] ?? emptyMeta();
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
