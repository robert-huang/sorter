/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDbFromBytes, serializeDb } from '../dbBytes';
import { currentVersion, migrate } from '../migration-runner';
import { pullMerge } from '../merge';
import { testSourceDescriptor, TEST_SOURCE_ID } from '../testSource';
import { getTestSqlite } from './testSqlite';

const findSourceDbFile = vi.fn();
const uploadSourceDb = vi.fn();
const downloadSourceDb = vi.fn();

vi.mock('../../cloud/googleDrive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cloud/googleDrive')>();
  return {
    ...actual,
    findSourceDbFile: (...args: unknown[]) => findSourceDbFile(...args),
    uploadSourceDb: (...args: unknown[]) => uploadSourceDb(...args),
    downloadSourceDb: (...args: unknown[]) => downloadSourceDb(...args),
  };
});

const localBytesBySource = new Map<string, Uint8Array>();

async function freshLocalBytes(): Promise<Uint8Array> {
  const sqlite3 = await getTestSqlite();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  migrate(db, testSourceDescriptor);
  const bytes = serializeDb(sqlite3, db);
  db.close();
  return bytes;
}

vi.mock('../client', () => ({
  openSourceDb: vi.fn(async (sourceId: string) => {
    if (!localBytesBySource.has(sourceId)) {
      localBytesBySource.set(sourceId, await freshLocalBytes());
    }
    return { schemaVersion: 2, storageMode: 'memory' as const };
  }),
  currentSchemaVersion: vi.fn(async (sourceId: string) => {
    const sqlite3 = await getTestSqlite();
    const bytes = localBytesBySource.get(sourceId) ?? (await freshLocalBytes());
    const db = openDbFromBytes(sqlite3, bytes);
    try {
      return currentVersion(db);
    } finally {
      db.close();
    }
  }),
  peekRemoteSchemaVersion: vi.fn(async (remoteBytes: Uint8Array) => {
    const sqlite3 = await getTestSqlite();
    const db = openDbFromBytes(sqlite3, remoteBytes);
    try {
      return currentVersion(db);
    } finally {
      db.close();
    }
  }),
  exportBytes: vi.fn(async (sourceId: string) => {
    const existing = localBytesBySource.get(sourceId);
    if (existing) {
      return existing;
    }
    const bytes = await freshLocalBytes();
    localBytesBySource.set(sourceId, bytes);
    return bytes;
  }),
  importBytes: vi.fn(async (sourceId: string, bytes: Uint8Array) => {
    localBytesBySource.set(sourceId, bytes);
  }),
  pullMerge: vi.fn(async (sourceId: string, remoteBytes: Uint8Array) => {
    // Mirrors what the real worker does (worker.ts 'pullMerge' case):
    // serialize the local DB to bytes, run the in-memory merge, write the
    // merged bytes back to the per-source slot (the worker uses replaceDb;
    // here we just overwrite the map entry).
    const sqlite3 = await getTestSqlite();
    const localBytes =
      localBytesBySource.get(sourceId) ?? (await freshLocalBytes());
    const merged = pullMerge(sqlite3, localBytes, sourceId, remoteBytes);
    localBytesBySource.set(sourceId, merged);
    return merged;
  }),
}));

import {
  NO_REMOTE,
  REMOTE_DRIFTED,
  REMOTE_SCHEMA_NEWER,
  getSyncState,
  pullDbFromDrive,
  pushDbToDrive,
} from '../sync';
import { ensureTestSourceRegistered } from '../testSource';
import {
  _clearDbSyncManifestForTesting,
  getSourceSyncMeta,
  patchSourceSyncMeta,
} from '../syncManifest';
import { exportBytes, importBytes, openSourceDb, pullMerge as clientPullMerge } from '../client';

const localStore = new Map<string, string>();

async function seedThing(
  id: string,
  label: string,
  fetchedAt: number,
): Promise<void> {
  await openSourceDb(TEST_SOURCE_ID);
  const sqlite3 = await getTestSqlite();
  let bytes = localBytesBySource.get(TEST_SOURCE_ID) ?? (await freshLocalBytes());
  const db = openDbFromBytes(sqlite3, bytes);
  db.exec(
    'INSERT INTO thing (id, label, fetched_at) VALUES (?, ?, ?)',
    { bind: [id, label, fetchedAt] },
  );
  bytes = serializeDb(sqlite3, db);
  db.close();
  localBytesBySource.set(TEST_SOURCE_ID, bytes);
}

beforeEach(() => {
  ensureTestSourceRegistered();
  localStore.clear();
  localBytesBySource.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStore.set(key, value);
    },
    removeItem: (key: string) => {
      localStore.delete(key);
    },
    clear: () => {
      localStore.clear();
    },
  });
  _clearDbSyncManifestForTesting();
  findSourceDbFile.mockReset();
  uploadSourceDb.mockReset();
  downloadSourceDb.mockReset();
  vi.mocked(openSourceDb).mockClear();
  vi.mocked(exportBytes).mockClear();
  vi.mocked(importBytes).mockClear();
  vi.mocked(clientPullMerge).mockClear();
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
  vi.unstubAllGlobals();
});

describe('pushDbToDrive', () => {
  it('first-time push succeeds and stores etag', async () => {
    findSourceDbFile.mockResolvedValue(null);
    uploadSourceDb.mockResolvedValue({ id: 'file-1', newEtag: 'etag-1' });
    await seedThing('x', 'one', 10);

    const result = await pushDbToDrive(TEST_SOURCE_ID);

    expect(result.remoteFileId).toBe('file-1');
    expect(result.remoteEtag).toBe('etag-1');
    expect(result.lastPushAt).toBeGreaterThan(0);
    const meta = getSourceSyncMeta(TEST_SOURCE_ID);
    expect(meta.remoteEtag).toBe('etag-1');
    expect(meta.lastPushAt).toBe(result.lastPushAt);
    expect(meta.driftDetected).toBe(false);
    expect(uploadSourceDb).toHaveBeenCalledWith(
      TEST_SOURCE_ID,
      expect.any(Uint8Array),
      null,
      undefined,
    );
  });

  it('throws REMOTE_DRIFTED when remote etag changed', async () => {
    await seedThing('x', 'one', 10);
    patchSourceSyncMeta(TEST_SOURCE_ID, {
      remoteEtag: 'etag-old',
      remoteFileId: 'file-1',
      hasLocalDb: true,
    });
    findSourceDbFile.mockResolvedValue({ id: 'file-1', etag: 'etag-new' });

    await expect(pushDbToDrive(TEST_SOURCE_ID)).rejects.toMatchObject({
      code: REMOTE_DRIFTED,
    });
    expect(getSourceSyncMeta(TEST_SOURCE_ID).driftDetected).toBe(true);
    expect(uploadSourceDb).not.toHaveBeenCalled();
  });

  it('throws REMOTE_SCHEMA_NEWER when remote schema is ahead', async () => {
    await seedThing('x', 'one', 10);
    const sqlite3 = await getTestSqlite();
    let remoteBytes = localBytesBySource.get(TEST_SOURCE_ID)!;
    const db = openDbFromBytes(sqlite3, remoteBytes);
    const localVersion = currentVersion(db);
    db.exec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
      { bind: [String(localVersion + 5)] },
    );
    remoteBytes = serializeDb(sqlite3, db);
    db.close();

    patchSourceSyncMeta(TEST_SOURCE_ID, {
      remoteEtag: 'etag-1',
      remoteFileId: 'file-1',
      hasLocalDb: true,
    });
    findSourceDbFile.mockResolvedValue({ id: 'file-1', etag: 'etag-1' });
    downloadSourceDb.mockResolvedValue({ bytes: remoteBytes, etag: 'etag-1' });

    await expect(pushDbToDrive(TEST_SOURCE_ID)).rejects.toMatchObject({
      code: REMOTE_SCHEMA_NEWER,
    });
  });

  it('happy-path push updates etag and lastPushAt', async () => {
    await seedThing('x', 'one', 10);
    const snapshot = localBytesBySource.get(TEST_SOURCE_ID)!;
    patchSourceSyncMeta(TEST_SOURCE_ID, {
      remoteEtag: 'etag-1',
      remoteFileId: 'file-1',
      hasLocalDb: true,
      lastPushAt: 1000,
    });
    findSourceDbFile.mockResolvedValue({ id: 'file-1', etag: 'etag-1' });
    downloadSourceDb.mockResolvedValue({ bytes: snapshot, etag: 'etag-1' });
    uploadSourceDb.mockResolvedValue({ id: 'file-1', newEtag: 'etag-2' });

    const result = await pushDbToDrive(TEST_SOURCE_ID);

    expect(result.remoteEtag).toBe('etag-2');
    expect(result.lastPushAt).toBeGreaterThan(1000);
    expect(getSyncState(TEST_SOURCE_ID).status).toBe('in-sync');
  });
});

describe('pullDbFromDrive', () => {
  it('throws NO_REMOTE when file is missing', async () => {
    findSourceDbFile.mockResolvedValue(null);
    await expect(pullDbFromDrive(TEST_SOURCE_ID)).rejects.toMatchObject({
      code: NO_REMOTE,
    });
  });

  it('first pull uses importBytes on a fresh device', async () => {
    await seedThing('only-remote', 'R', 50);
    const remoteBytes = localBytesBySource.get(TEST_SOURCE_ID)!;
    localBytesBySource.delete(TEST_SOURCE_ID);
    _clearDbSyncManifestForTesting();

    findSourceDbFile.mockResolvedValue({ id: 'file-9', etag: 'etag-9' });
    downloadSourceDb.mockResolvedValue({ bytes: remoteBytes, etag: 'etag-9' });

    const result = await pullDbFromDrive(TEST_SOURCE_ID);

    expect(result.merged).toBe(false);
    expect(importBytes).toHaveBeenCalledWith(TEST_SOURCE_ID, remoteBytes);
    expect(clientPullMerge).not.toHaveBeenCalled();
    expect(getSourceSyncMeta(TEST_SOURCE_ID).hasLocalDb).toBe(true);
  });

  it('merges divergent local and remote rows', async () => {
    await seedThing('from-remote', 'R', 200);
    const remoteBytes = localBytesBySource.get(TEST_SOURCE_ID)!;

    const sqlite3 = await getTestSqlite();
    const localDb = openDbFromBytes(sqlite3, await freshLocalBytes());
    localDb.exec(
      'INSERT INTO thing (id, label, fetched_at) VALUES (?, ?, ?)',
      { bind: ['from-local', 'L', 100] },
    );
    const localBytes = serializeDb(sqlite3, localDb);
    localDb.close();
    localBytesBySource.set(TEST_SOURCE_ID, localBytes);
    patchSourceSyncMeta(TEST_SOURCE_ID, { hasLocalDb: true });

    findSourceDbFile.mockResolvedValue({ id: 'file-m', etag: 'etag-m' });
    downloadSourceDb.mockResolvedValue({ bytes: remoteBytes, etag: 'etag-m' });

    const result = await pullDbFromDrive(TEST_SOURCE_ID);

    expect(result.merged).toBe(true);
    expect(clientPullMerge).toHaveBeenCalled();
    const mergedDb = openDbFromBytes(sqlite3, localBytesBySource.get(TEST_SOURCE_ID)!);
    const ids = mergedDb
      .selectObjects('SELECT id FROM thing ORDER BY id')
      .map((r) => r.id);
    mergedDb.close();
    expect(ids).toEqual(['from-local', 'from-remote']);
  });

  it('throws REMOTE_SCHEMA_NEWER on pull', async () => {
    const sqlite3 = await getTestSqlite();
    const localBytes = await freshLocalBytes();
    localBytesBySource.set(TEST_SOURCE_ID, localBytes);

    const remoteDb = openDbFromBytes(sqlite3, localBytes);
    remoteDb.exec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
      { bind: ['99'] },
    );
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    findSourceDbFile.mockResolvedValue({ id: 'file-x', etag: 'e' });
    downloadSourceDb.mockResolvedValue({ bytes: remoteBytes, etag: 'e' });

    await expect(pullDbFromDrive(TEST_SOURCE_ID)).rejects.toMatchObject({
      code: REMOTE_SCHEMA_NEWER,
    });
  });
});

describe('getSyncState', () => {
  it('returns unknown before any sync activity', () => {
    expect(getSyncState(TEST_SOURCE_ID).status).toBe('unknown');
  });

  it('returns in-sync after a successful push', () => {
    patchSourceSyncMeta(TEST_SOURCE_ID, {
      remoteEtag: 'e1',
      lastPushAt: Date.now(),
      remoteFileId: 'f1',
      hasLocalDb: true,
    });
    expect(getSyncState(TEST_SOURCE_ID).status).toBe('in-sync');
  });

  it('returns drifted when driftDetected is set', () => {
    patchSourceSyncMeta(TEST_SOURCE_ID, { driftDetected: true });
    expect(getSyncState(TEST_SOURCE_ID).status).toBe('drifted');
  });

  it('returns unsynced when local db exists but never pushed', () => {
    patchSourceSyncMeta(TEST_SOURCE_ID, { hasLocalDb: true });
    expect(getSyncState(TEST_SOURCE_ID).status).toBe('unsynced');
  });
});
