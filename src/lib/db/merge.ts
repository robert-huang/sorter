import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { openDbFromBytes, serializeDb } from './dbBytes';
import { currentVersion, migrateTo } from './migration-runner';
import { getSource, type SourceMergeTable } from './source-registry';

export const REMOTE_SCHEMA_NEWER = 'REMOTE_SCHEMA_NEWER';

function getColumnList(db: Database, tableName: string): string[] {
  const rows = db.selectObjects(`PRAGMA table_info(${tableName})`);
  return rows
    .map((r) => r.name)
    .filter((name): name is string => typeof name === 'string');
}

function upsertTable(
  localDb: Database,
  table: SourceMergeTable,
  remoteAlias: string,
): void {
  const colList = getColumnList(localDb, table.name);
  const cols = colList.join(', ');
  const pkJoin = table.pk
    .map((pk) => `${table.name}.${pk} = r.${pk}`)
    .join(' AND ');
  const ts = table.timestampCol;
  const nonPk = colList.filter((c) => !table.pk.includes(c));

  localDb.exec(`
    INSERT OR IGNORE INTO ${table.name} (${cols})
    SELECT ${cols} FROM ${remoteAlias}.${table.name};
  `);

  if (nonPk.length === 0) {
    return;
  }

  const setClause = nonPk
    .map(
      (c) =>
        `${c} = (SELECT r.${c} FROM ${remoteAlias}.${table.name} r WHERE ${pkJoin})`,
    )
    .join(', ');

  localDb.exec(`
    UPDATE ${table.name} SET ${setClause}
    WHERE EXISTS (
      SELECT 1 FROM ${remoteAlias}.${table.name} r
      WHERE ${pkJoin} AND r.${ts} > ${table.name}.${ts}
    );
  `);
}

function attachBytesDb(
  sqlite3: Sqlite3Static,
  localDb: Database,
  bytes: Uint8Array,
): string {
  const path = `/merge-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  sqlite3.capi.sqlite3_js_posix_create_file(path, bytes);
  localDb.exec(`ATTACH DATABASE '${path}' AS remote`);
  return path;
}

function detachRemote(localDb: Database, path: string): void {
  localDb.exec('DETACH DATABASE remote');
  try {
    localDb.exec(`PRAGMA main.vfs_list`);
  } catch {
    // best-effort cleanup; temp file lives in wasm vfs
  }
  void path;
}

/**
 * Merges remote serialized bytes into localDb (newer timestamp wins per row).
 * Returns serialized bytes of the merged local database.
 */
export function pullMerge(
  sqlite3: Sqlite3Static,
  localDb: Database,
  sourceId: string,
  remoteBytes: Uint8Array,
): Uint8Array {
  const source = getSource(sourceId);
  const localVersion = currentVersion(localDb);

  const remoteDb = openDbFromBytes(sqlite3, remoteBytes);
  let attachPath: string | null = null;
  let remoteClosed = false;

  try {
    const remoteVersion = currentVersion(remoteDb);

    if (remoteVersion > localVersion) {
      throw Object.assign(new Error('Remote schema is newer than local'), {
        code: REMOTE_SCHEMA_NEWER,
      });
    }

    if (remoteVersion < localVersion) {
      migrateTo(remoteDb, source, localVersion);
    }

    const upgradedBytes = serializeDb(sqlite3, remoteDb);
    remoteDb.close();
    remoteClosed = true;

    attachPath = attachBytesDb(sqlite3, localDb, upgradedBytes);

    localDb.transaction(() => {
      for (const t of source.merge.metadataTables) {
        upsertTable(localDb, t, 'remote');
      }
      for (const t of source.merge.userDataTables) {
        upsertTable(localDb, t, 'remote');
      }
    });
  } finally {
    if (attachPath) {
      detachRemote(localDb, attachPath);
    }
    if (!remoteClosed) {
      remoteDb.close();
    }
  }

  return serializeDb(sqlite3, localDb);
}

/** Reads schema_version from serialized DB bytes without touching the local store. */
export function peekRemoteSchemaVersion(
  sqlite3: Sqlite3Static,
  remoteBytes: Uint8Array,
): number {
  const remoteDb = openDbFromBytes(sqlite3, remoteBytes);
  try {
    return currentVersion(remoteDb);
  } finally {
    remoteDb.close();
  }
}
