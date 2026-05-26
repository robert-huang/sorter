/**
 * Regression test for the sqlite-wasm binding contract.
 *
 * Bug history: `worker.ts` was doing `db.exec(sql, params_array)` to
 * route INSERT/UPDATE/DELETE params from the main thread into SQLite.
 * sqlite-wasm's `exec(sql, opts)` parses the second argument as an
 * options object — passing a bare array means `opts.bind` is undefined,
 * so every `?` placeholder silently binds NULL. The first real import
 * of an AniList user blew up with
 *   `NOT NULL constraint failed: anilist_user.name`
 * because every column got NULL on the way in.
 *
 * Fix: route through `execWithBinds`, which wraps params in
 * `{ bind: params }`. This test pins both halves of the contract:
 *   1. The wrapper produces correct binds.
 *   2. The bare-array call form would silently bind NULLs (left in
 *      as documentation of the trap we're protecting against).
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { execWithBinds } from '../dbExec';
import { openMemoryDb } from './testSqlite';

async function freshDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec(`
    CREATE TABLE t (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      score INTEGER
    )
  `);
  return db;
}

describe('execWithBinds', () => {
  let db: Database;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('binds positional params correctly for an INSERT', () => {
    execWithBinds(
      db,
      'INSERT INTO t (id, name, score) VALUES (?, ?, ?)',
      [1, 'robert', 42],
    );
    const row = db.selectObject('SELECT * FROM t WHERE id = 1');
    expect(row).toEqual({ id: 1, name: 'robert', score: 42 });
  });

  it('runs a parameter-less statement when params is undefined', () => {
    execWithBinds(db, "INSERT INTO t (id, name) VALUES (1, 'literal')", undefined);
    const row = db.selectObject('SELECT name FROM t WHERE id = 1');
    expect(row?.name).toBe('literal');
  });

  it('binds an UPSERT with `excluded.*` references', () => {
    // Mirrors the buildUpsertSql output the importer uses for
    // anilist_user — this is the exact statement that blew up
    // before the worker fix.
    const upsert =
      'INSERT INTO t (id, name, score) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, score = excluded.score';
    execWithBinds(db, upsert, [1, 'alice', 10]);
    execWithBinds(db, upsert, [1, 'alice-renamed', 20]);
    const row = db.selectObject('SELECT name, score FROM t WHERE id = 1');
    expect(row).toEqual({ name: 'alice-renamed', score: 20 });
  });

  // This test documents the trap the wrapper exists to avoid. If
  // sqlite-wasm ever changes its `exec(sql, array)` semantics to
  // bind directly, this test breaks and we can simplify the
  // wrapper. Until then, the bare-array form must not be used.
  it('regression: `db.exec(sql, bareArray)` silently binds NULL (DO NOT use this form)', () => {
    // Schema constrains name NOT NULL, so the NULL bind throws
    // exactly like production did. Use a column that allows NULL
    // so the bug surfaces as "wrong value", not "thrown error".
    expect(() =>
      (db as unknown as { exec: (s: string, b?: unknown) => void }).exec(
        'INSERT INTO t (id, name, score) VALUES (?, ?, ?)',
        [1, 'robert', 42],
      ),
    ).toThrow(/NOT NULL/);
  });
});
