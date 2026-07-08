import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { openDbFromBytes, serializeDb } from './dbBytes';
import { currentVersion, migrateTo } from './migration-runner';
import { ANILIST_SOURCE_ID } from '../importers/anilist/anilistSource';
import { mergeMediaCastExpansionSplit } from '../importers/anilist/mergeCastExpansion';
import { getSource, type SourceMergeTable } from './source-registry';

export const REMOTE_SCHEMA_NEWER = 'REMOTE_SCHEMA_NEWER';

function getColumnList(db: Database, tableName: string): string[] {
  const rows = db.selectObjects(`PRAGMA table_info(${tableName})`);
  return rows
    .map((r) => r.name)
    .filter((name): name is string => typeof name === 'string');
}

function unionJunctionTable(
  localDb: Database,
  tableName: string,
  remoteAlias: string,
): void {
  const colList = getColumnList(localDb, tableName);
  const cols = colList.join(', ');
  localDb.exec(`
    INSERT OR IGNORE INTO ${tableName} (${cols})
    SELECT ${cols} FROM ${remoteAlias}.${tableName};
  `);
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

/**
 * Writes `bytes` to a posix path in the WASM "unix" VFS and ATTACHes it onto
 * `localDb`. Only safe when `localDb` is itself on the unix VFS (e.g. `:memory:`
 * via `openDbFromBytes`). ATTACH from an OPFS-SAH-Pool connection would look
 * up the path inside the sahpool VFS — a different filesystem — and silently
 * create an empty DB, which is the bug that motivated the bytes-in/bytes-out
 * contract on `pullMerge`.
 */
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

function detachRemote(
  sqlite3: Sqlite3Static,
  localDb: Database,
  path: string,
): void {
  localDb.exec('DETACH DATABASE remote');
  // Free the temp file in the unix VFS so repeated merges don't leak storage
  // for the worker's lifetime. `0` selects the default VFS (where
  // sqlite3_js_posix_create_file wrote the file). Best-effort: if the export
  // is missing in some future sqlite-wasm build, silently no-op.
  try {
    const wasmUnlink = (
      sqlite3.wasm as unknown as {
        sqlite3__wasm_vfs_unlink?: (pVfs: number, filename: string) => number;
      }
    ).sqlite3__wasm_vfs_unlink;
    if (typeof wasmUnlink === 'function') {
      wasmUnlink(0, path);
    }
  } catch {
    /* unlink is best-effort */
  }
}

/**
 * Merges `remoteBytes` into `localBytes` (newer timestamp wins per row),
 * returning the merged serialized bytes. Operates entirely on in-memory
 * (unix VFS) connections so callers can pass DBs backed by any VFS — they
 * just round-trip the bytes.
 *
 * Throws an Error with `code: REMOTE_SCHEMA_NEWER` if the remote's
 * `_meta.schema_version` is ahead of local's (caller must surface an
 * "update the app" path; cross-version merge is not safe).
 */
export function pullMerge(
  sqlite3: Sqlite3Static,
  localBytes: Uint8Array,
  sourceId: string,
  remoteBytes: Uint8Array,
): Uint8Array {
  const source = getSource(sourceId);

  const localDb = openDbFromBytes(sqlite3, localBytes);
  const remoteDb = openDbFromBytes(sqlite3, remoteBytes);
  let attachPath: string | null = null;
  let remoteClosed = false;

  try {
    const localVersion = currentVersion(localDb);
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
      for (const tableName of source.merge.junctionUnionTables ?? []) {
        unionJunctionTable(localDb, tableName, 'remote');
      }
      if (sourceId === ANILIST_SOURCE_ID) {
        mergeMediaCastExpansionSplit(localDb);
      }
    });

    return serializeDb(sqlite3, localDb);
  } finally {
    if (attachPath) {
      detachRemote(sqlite3, localDb, attachPath);
    }
    if (!remoteClosed) {
      remoteDb.close();
    }
    localDb.close();
  }
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
