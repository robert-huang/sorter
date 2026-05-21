import { describe, expect, it } from 'vitest';
import { serializeDb } from '../dbBytes';
import { migrate, setSchemaVersion } from '../migration-runner';
import { pullMerge, REMOTE_SCHEMA_NEWER } from '../merge';
import { registerSource, type SourceDescriptor } from '../source-registry';
import { testSourceDescriptor } from '../testSource';
import { getTestSqlite, openMemoryDb } from './testSqlite';

const MERGE_TEST_SOURCE_ID = 'merge-test';

const mergeTestSource: SourceDescriptor = {
  ...testSourceDescriptor,
  id: MERGE_TEST_SOURCE_ID,
};

function ensureMergeTestSource(): void {
  try {
    registerSource(mergeTestSource);
  } catch {
    // already registered
  }
}

ensureMergeTestSource();

async function freshMigratedDb() {
  const db = await openMemoryDb();
  migrate(db, mergeTestSource);
  return db;
}

describe('pullMerge', () => {
  it('union disjoint divergent DBs', async () => {
    const sqlite3 = await getTestSqlite();
    const localDb = await freshMigratedDb();
    localDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('a', 'local-a', 100)",
    );

    const remoteDb = await freshMigratedDb();
    remoteDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('b', 'remote-b', 200)",
    );
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    pullMerge(sqlite3, localDb, MERGE_TEST_SOURCE_ID, remoteBytes);

    const rows = localDb.selectObjects('SELECT id FROM thing ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    localDb.close();
  });

  it('newer timestamp wins for the same row', async () => {
    const sqlite3 = await getTestSqlite();
    const localDb = await freshMigratedDb();
    localDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('x', 'old-local', 50)",
    );

    const remoteDb = await freshMigratedDb();
    remoteDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('x', 'new-remote', 500)",
    );
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    pullMerge(sqlite3, localDb, MERGE_TEST_SOURCE_ID, remoteBytes);

    const row = localDb.selectObject("SELECT label FROM thing WHERE id = 'x'");
    expect(row?.label).toBe('new-remote');
    localDb.close();
  });

  it('throws REMOTE_SCHEMA_NEWER when remote schema is ahead', async () => {
    const sqlite3 = await getTestSqlite();
    const localDb = await freshMigratedDb();
    migrate(localDb, mergeTestSource);

    const remoteDb = await freshMigratedDb();
    setSchemaVersion(remoteDb, 99);
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    expect(() =>
      pullMerge(sqlite3, localDb, MERGE_TEST_SOURCE_ID, remoteBytes),
    ).toThrowError(expect.objectContaining({ code: REMOTE_SCHEMA_NEWER }));
    localDb.close();
  });

  it('upgrades older remote schema then merges', async () => {
    const sqlite3 = await getTestSqlite();
    const localDb = await freshMigratedDb();
    localDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('only-local', 'L', 1)",
    );
    localDb.exec(
      "INSERT INTO user_note (id, body, updated_at) VALUES ('n1', 'local note', 10)",
    );

    const remoteDb = await openMemoryDb();
    migrate(remoteDb, {
      ...mergeTestSource,
      migrations: [mergeTestSource.migrations[0]!],
    });
    remoteDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('only-remote', 'R', 2)",
    );
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    pullMerge(sqlite3, localDb, MERGE_TEST_SOURCE_ID, remoteBytes);

    const things = localDb.selectObjects('SELECT id FROM thing ORDER BY id');
    expect(things.map((t) => t.id)).toEqual(['only-local', 'only-remote']);

    const notes = localDb.selectObjects('SELECT id FROM user_note ORDER BY id');
    expect(notes.map((n) => n.id)).toEqual(['n1']);
    localDb.close();
  });

  it('rolls back when merge fails mid-transaction', async () => {
    const sqlite3 = await getTestSqlite();
    const brokenSource: SourceDescriptor = {
      id: 'merge-broken',
      migrations: testSourceDescriptor.migrations,
      merge: {
        metadataTables: [{ name: 'thing', pk: ['id'], timestampCol: 'fetched_at' }],
        userDataTables: [
          { name: 'missing_table', pk: ['id'], timestampCol: 'updated_at' },
        ],
      },
    };
    try {
      registerSource(brokenSource);
    } catch {
      // already registered
    }

    const localDb = await freshMigratedDb();
    localDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('keep', 'stable', 1)",
    );

    const remoteDb = await freshMigratedDb();
    remoteDb.exec(
      "INSERT INTO thing (id, label, fetched_at) VALUES ('new', 'incoming', 2)",
    );
    const remoteBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();

    expect(() =>
      pullMerge(sqlite3, localDb, 'merge-broken', remoteBytes),
    ).toThrow();

    const count = localDb.selectValue("SELECT COUNT(*) FROM thing WHERE id = 'new'");
    expect(count).toBe(0);
    const kept = localDb.selectValue("SELECT label FROM thing WHERE id = 'keep'");
    expect(kept).toBe('stable');
    localDb.close();
  });
});
