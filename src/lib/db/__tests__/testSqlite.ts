import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

let sqlite3Promise: Promise<Sqlite3Static> | null = null;

export async function getTestSqlite(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    // Package types omit Emscripten init options; runtime accepts them.
    sqlite3Promise = (sqlite3InitModule as (config?: object) => ReturnType<typeof sqlite3InitModule>)({
      print: () => {},
      printErr: () => {},
    });
  }
  return sqlite3Promise;
}

export async function openMemoryDb(): Promise<Database> {
  const sqlite3 = await getTestSqlite();
  return new sqlite3.oo1.DB(':memory:', 'c');
}
