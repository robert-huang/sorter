import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

/** Opens an empty in-memory database and loads serialized SQLite bytes into it. */
export function openDbFromBytes(sqlite3: Sqlite3Static, bytes: Uint8Array): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const { wasm, capi } = sqlite3;
  const ptr = wasm.allocFromTypedArray(bytes);
  const flags =
    capi.SQLITE_DESERIALIZE_RESIZEABLE | capi.SQLITE_DESERIALIZE_FREEONCLOSE;
  const rc = capi.sqlite3_deserialize(
    db.pointer!,
    'main',
    ptr,
    bytes.length,
    bytes.length,
    flags,
  );
  if (rc !== capi.SQLITE_OK) {
    db.close();
    throw new Error(
      `sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`,
    );
  }
  // FK enforcement is per-connection in SQLite; mirror worker.ts so merge
  // (which runs entirely on these in-memory connections) honors cascades for
  // sources whose schema declares them (e.g. anilist).
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Serializes a database to bytes via sqlite3_js_db_export (in-memory / deserialized DBs). */
export function serializeDb(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db);
}
