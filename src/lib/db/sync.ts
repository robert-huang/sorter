import { CloudEtagMismatchError } from '../cloud/googleDrive';
import {
  downloadSourceDb,
  findSourceDbFile,
  uploadSourceDb,
} from '../cloud/googleDrive';
import {
  currentSchemaVersion,
  exportBytes,
  importBytes,
  openSourceDb,
  peekRemoteSchemaVersion,
  pullMerge,
} from './client';
import { REMOTE_SCHEMA_NEWER } from './merge';

export { REMOTE_SCHEMA_NEWER };
import {
  clearPendingChanges,
  getSourceSyncMeta,
  patchSourceSyncMeta,
} from './syncManifest';

export const REMOTE_DRIFTED = 'REMOTE_DRIFTED';
export const NO_REMOTE = 'NO_REMOTE';
/**
 * Push refused because this tab's SQLite worker fell back to in-memory
 * storage (another tab of the same origin holds the OPFS SAH pool, or
 * OPFS install failed). Pushing memory-mode bytes is unsafe because:
 *   - `meta.remoteEtag` lives in localStorage and is shared across
 *     tabs, so the optimistic-concurrency check passes even when the
 *     OPFS-holding tab's bytes are strictly newer than what this tab
 *     last pulled.
 *   - A fresh second tab that never pulled would push an empty DB on
 *     top of the canonical Drive copy — recoverable from the
 *     OPFS-holding tab as long as it stays open, but permanent data
 *     loss if that tab closes first.
 * Pull is intentionally NOT blocked: it only writes to this tab's
 * memory worker and can't corrupt anything else.
 */
export const MEMORY_MODE_PUSH_BLOCKED = 'MEMORY_MODE_PUSH_BLOCKED';

export type SyncStatus = 'unsynced' | 'in-sync' | 'drifted' | 'unknown';

export type SyncState = {
  lastPushAt: number | null;
  lastPullAt: number | null;
  remoteEtag: string | null;
  status: SyncStatus;
};

export type PushResult = {
  remoteFileId: string;
  remoteEtag: string;
  lastPushAt: number;
};

export type PullResult = {
  remoteFileId: string;
  remoteEtag: string;
  lastPullAt: number;
  merged: boolean;
};

export function codedError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function rethrowWithCode(err: unknown): never {
  const e = err as Error & { code?: string };
  if (e.code === REMOTE_SCHEMA_NEWER) {
    throw codedError(
      REMOTE_SCHEMA_NEWER,
      e.message || 'Remote schema is newer than this app supports.',
    );
  }
  throw err;
}

export function getSyncState(sourceId: string): SyncState {
  const meta = getSourceSyncMeta(sourceId);
  let status: SyncStatus = 'unknown';

  if (meta.driftDetected) {
    status = 'drifted';
  } else if (meta.pendingChanges > 0) {
    status = 'unsynced';
  } else if (!meta.remoteFileId && !meta.lastPushAt && !meta.lastPullAt) {
    status = meta.hasLocalDb ? 'unsynced' : 'unknown';
  } else if (meta.hasLocalDb && meta.lastPushAt === null) {
    status = 'unsynced';
  } else if (meta.remoteEtag && meta.lastPushAt !== null) {
    status = 'in-sync';
  } else if (meta.hasLocalDb) {
    status = 'unsynced';
  }

  return {
    lastPushAt: meta.lastPushAt,
    lastPullAt: meta.lastPullAt,
    remoteEtag: meta.remoteEtag,
    status,
  };
}

async function assertRemoteSchemaNotNewer(
  remoteBytes: Uint8Array,
  sourceId: string,
): Promise<void> {
  const remoteVersion = await peekRemoteSchemaVersion(remoteBytes);
  await openSourceDb(sourceId);
  const localVersion = await currentSchemaVersion(sourceId);
  if (remoteVersion > localVersion) {
    throw codedError(
      REMOTE_SCHEMA_NEWER,
      `Remote schema version ${remoteVersion} is newer than local ${localVersion}.`,
    );
  }
}

export async function pushDbToDrive(sourceId: string): Promise<PushResult> {
  getSourceSyncMeta(sourceId);
  const { storageMode } = await openSourceDb(sourceId);

  // Defense-in-depth: blocking push here (rather than only at the UI)
  // means any future caller that bypasses the SettingsMenu button can't
  // accidentally overwrite Drive with stale/empty memory-mode bytes.
  // See the MEMORY_MODE_PUSH_BLOCKED comment for the full rationale.
  if (storageMode === 'memory') {
    throw codedError(
      MEMORY_MODE_PUSH_BLOCKED,
      'Push refused: this tab is using non-persistent storage. Close any other tabs of this app and reload, then push from the persistent tab.',
    );
  }

  const remote = await findSourceDbFile(sourceId);
  const meta = getSourceSyncMeta(sourceId);

  if (remote) {
    if (meta.remoteEtag && remote.etag !== meta.remoteEtag) {
      patchSourceSyncMeta(sourceId, { driftDetected: true });
      throw codedError(
        REMOTE_DRIFTED,
        'Remote database changed since last sync — pull first to merge.',
      );
    }

    const { bytes: remoteBytes } = await downloadSourceDb(remote.id);
    try {
      await assertRemoteSchemaNotNewer(remoteBytes, sourceId);
    } catch (err) {
      rethrowWithCode(err);
    }
  }

  const localBytes = await exportBytes(sourceId);
  let upload;
  try {
    upload = await uploadSourceDb(
      sourceId,
      localBytes,
      remote?.id ?? meta.remoteFileId,
      remote && meta.remoteEtag ? meta.remoteEtag : undefined,
    );
  } catch (err) {
    if (err instanceof CloudEtagMismatchError) {
      patchSourceSyncMeta(sourceId, { driftDetected: true });
      throw codedError(
        REMOTE_DRIFTED,
        'Remote database changed since last sync — pull first to merge.',
      );
    }
    throw err;
  }

  const now = Date.now();
  patchSourceSyncMeta(sourceId, {
    remoteFileId: upload.id,
    remoteEtag: upload.newEtag,
    lastPushAt: now,
    hasLocalDb: true,
    driftDetected: false,
  });
  // Successful push absorbs every ad-hoc write that was accumulated
  // via bumpPendingChanges (Phase D per-entry refresh). Reset here
  // rather than at every call site so the contract is "push ==
  // pending-changes is zero again", not negotiated per-caller.
  clearPendingChanges(sourceId);

  return {
    remoteFileId: upload.id,
    remoteEtag: upload.newEtag,
    lastPushAt: now,
  };
}

export async function pullDbFromDrive(sourceId: string): Promise<PullResult> {
  const meta = getSourceSyncMeta(sourceId);
  const remote = await findSourceDbFile(sourceId);

  if (!remote) {
    throw codedError(NO_REMOTE, `No cloud database found for source '${sourceId}'.`);
  }

  const { bytes, etag } = await downloadSourceDb(remote.id);

  try {
    await assertRemoteSchemaNotNewer(bytes, sourceId);
  } catch (err) {
    rethrowWithCode(err);
  }

  let merged = false;
  if (!meta.hasLocalDb) {
    await importBytes(sourceId, bytes);
  } else {
    // pullMerge writes the merged bytes back to the OPFS/memory slot itself
    // (via replaceDb in the worker), so no follow-up importBytes call here.
    await pullMerge(sourceId, bytes);
    merged = true;
  }

  const now = Date.now();
  patchSourceSyncMeta(sourceId, {
    remoteFileId: remote.id,
    remoteEtag: etag,
    lastPullAt: now,
    hasLocalDb: true,
    driftDetected: false,
  });

  return {
    remoteFileId: remote.id,
    remoteEtag: etag,
    lastPullAt: now,
    merged,
  };
}
