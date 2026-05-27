import type { Database } from '@sqlite.org/sqlite-wasm';
import { maxMigrationVersion, type SourceDescriptor } from './source-registry';

export function ensureMetaTable(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)');
}

export function currentVersion(db: Database): number {
  ensureMetaTable(db);
  const row = db.selectObject("SELECT value FROM _meta WHERE key = 'schema_version'");
  const value = row?.value;
  return typeof value === 'string' ? parseInt(value, 10) : 0;
}

export function setSchemaVersion(db: Database, version: number): void {
  db.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)", {
    bind: [String(version)],
  });
}

export function migrate(db: Database, source: SourceDescriptor): number {
  ensureMetaTable(db);
  const current = currentVersion(db);
  const pending = source.migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      setSchemaVersion(db, m.version);
    });
  }

  return maxMigrationVersion(source) || current;
}

export function migrateTo(
  db: Database,
  source: SourceDescriptor,
  targetVersion: number,
): void {
  ensureMetaTable(db);
  const current = currentVersion(db);
  if (current >= targetVersion) {
    return;
  }

  const pending = source.migrations
    .filter((m) => m.version > current && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      setSchemaVersion(db, m.version);
    });
  }
}

export function assertDbSchemaSupported(db: Database, source: SourceDescriptor): void {
  const version = currentVersion(db);
  const maxVersion = maxMigrationVersion(source);
  if (version > maxVersion) {
    throw Object.assign(
      new Error(
        `Database schema version ${version} is newer than this app supports (${maxVersion})`,
      ),
      { code: 'LOCAL_SCHEMA_NEWER' },
    );
  }
}
