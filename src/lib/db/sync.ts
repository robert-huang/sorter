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
import { getSourceSyncMeta, patchSourceSyncMeta } from './syncManifest';

export const REMOTE_DRIFTED = 'REMOTE_DRIFTED';
export const NO_REMOTE = 'NO_REMOTE';

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
  await openSourceDb(sourceId);

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
    const mergedBytes = await pullMerge(sourceId, bytes);
    await importBytes(sourceId, mergedBytes);
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
