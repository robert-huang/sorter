import { describe, expect, it } from 'vitest';
import {
  currentVersion,
  migrate,
  migrateTo,
  setSchemaVersion,
} from '../migration-runner';
import type { SourceDescriptor } from '../source-registry';
import { openMemoryDb } from './testSqlite';

const sourceV1Only: SourceDescriptor = {
  id: 'mig-test-v1',
  migrations: [{ version: 1, sql: 'CREATE TABLE alpha (id TEXT PRIMARY KEY);' }],
  merge: { metadataTables: [], userDataTables: [] },
};

const sourceV1V2: SourceDescriptor = {
  id: 'mig-test-v2',
  migrations: [
    { version: 1, sql: 'CREATE TABLE alpha (id TEXT PRIMARY KEY);' },
    { version: 2, sql: 'CREATE TABLE beta (id TEXT PRIMARY KEY);' },
  ],
  merge: { metadataTables: [], userDataTables: [] },
};

describe('migration-runner', () => {
  it('fresh DB applies all migrations', async () => {
    const db = await openMemoryDb();
    const version = migrate(db, sourceV1V2);
    expect(version).toBe(2);
    expect(currentVersion(db)).toBe(2);
    expect(db.selectValue("SELECT name FROM sqlite_master WHERE type='table' AND name='beta'")).toBe(
      'beta',
    );
    db.close();
  });

  it('partial DB applies only missing migrations', async () => {
    const db = await openMemoryDb();
    migrate(db, sourceV1Only);
    setSchemaVersion(db, 1);
    migrate(db, sourceV1V2);
    expect(currentVersion(db)).toBe(2);
    expect(db.selectValue("SELECT name FROM sqlite_master WHERE type='table' AND name='beta'")).toBe(
      'beta',
    );
    db.close();
  });

  it('empty migrations array is a no-op', async () => {
    const db = await openMemoryDb();
    const empty: SourceDescriptor = {
      id: 'empty',
      migrations: [],
      merge: { metadataTables: [], userDataTables: [] },
    };
    migrate(db, empty);
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  it('migrateTo stops at target version', async () => {
    const db = await openMemoryDb();
    migrateTo(db, sourceV1V2, 1);
    expect(currentVersion(db)).toBe(1);
    expect(db.selectValue("SELECT name FROM sqlite_master WHERE type='table' AND name='beta'")).toBe(
      undefined,
    );
    db.close();
  });
});
