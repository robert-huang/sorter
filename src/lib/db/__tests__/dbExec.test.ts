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

/**
 * Bind-error diagnostic wrap. sqlite-wasm's native error is
 *   `unsupported bind() argument type: object`
 * with no SQL, no param index, no value preview — so when the
 * importer hits it from inside a 1000-statement `execBatch`, the
 * user has nothing to triage from. `execWithBinds` catches that
 * specific shape and re-throws with the SQL, every non-bindable
 * param's index, and a short dump of its value.
 *
 * These tests pin both the wrapping behavior and the carefully
 * narrow trigger condition (NOT NULL / UNIQUE / FK / syntax errors
 * already carry context — wrapping them would only add noise).
 */
describe('execWithBinds diagnostic wrap', () => {
  let db: Database;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('flags a plain object with SQL + param index + JSON value preview', () => {
    // The classic production bug: a row-shaped object slips into a
    // positional bind because someone forgot to map/spread. The
    // diagnostic must identify which column it landed in AND dump
    // enough of the value that the upstream mapper (which entry,
    // which field) is identifiable from one stack trace.
    const badObject = { id: 99, deep: { nested: 'value' } };
    let captured: Error | null = null;
    try {
      execWithBinds(
        db,
        'INSERT INTO t (id, name, score) VALUES (?, ?, ?)',
        [1, badObject, 42],
      );
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    const msg = captured!.message;
    expect(msg).toMatch(/SQLite bind failed/);
    expect(msg).toMatch(/params\[1\]/);
    // JSON dump so upstream row context is visible:
    expect(msg).toMatch(/"deep":/);
    expect(msg).toMatch(/"nested":"value"/);
    // SQL snippet so a multi-statement batch failure is triageable:
    expect(msg).toMatch(/INSERT INTO t/);
  });

  it('post-hoc catch path: if sqlite-wasm rejects a value the pre-check missed, wrap that too with `cause`', () => {
    // Defense-in-depth: a future sqlite-wasm version could tighten
    // its bind rules (e.g. reject out-of-range BigInts, or reject a
    // new typeof we forgot about). The wrapper's try/catch still
    // produces a diagnostic for those cases AND chains the original
    // via `Error.cause` so devtools / Sentry still get the underlying
    // frame. Reproduce by injecting a stub db whose `exec` throws
    // exactly the sqlite-wasm error string — that bypasses the
    // pre-validation pass since the params themselves are all
    // scalar.
    const stubError = new Error('unsupported bind() argument type: object');
    const stubDb = {
      exec: ((_sql: string, _opts?: unknown) => {
        throw stubError;
      }) as ((sql: string) => unknown) & ((sql: string, opts: unknown) => unknown),
    };
    let captured: (Error & { cause?: unknown }) | null = null;
    try {
      // All params are scalar, so pre-validation passes; the stub
      // throws and the post-hoc catch wraps it.
      execWithBinds(stubDb, 'INSERT INTO t (id, name) VALUES (?, ?)', [1, 'ok']);
    } catch (e) {
      captured = e as Error & { cause?: unknown };
    }
    expect(captured?.message).toMatch(/SQLite bind failed/);
    // No specific param flagged because everything LOOKED valid — message
    // hints at version drift so the next debugger isn't sent on a wild
    // chase for a bad mapper that doesn't exist.
    expect(captured?.message).toMatch(/version mismatch suspected/);
    expect(captured?.message).toMatch(/Original: unsupported bind\(\)/i);
    expect(captured?.cause).toBe(stubError);
  });

  it('flags multiple bad params in one message so the first index is not the only clue', () => {
    let captured: Error | null = null;
    try {
      execWithBinds(
        db,
        'INSERT INTO t (id, name, score) VALUES (?, ?, ?)',
        [{ a: 1 }, 'name', { b: 2 }],
      );
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toMatch(/params\[0\]/);
    expect(captured?.message).toMatch(/params\[2\]/);
    // Counts both bad params so a glance at the header tells you it's
    // a row-shape problem (multiple columns), not a single stray field.
    expect(captured?.message).toMatch(/Non-bindable params \(2 of 3\)/);
  });

  it('does NOT wrap unrelated SQLite errors (NOT NULL, UNIQUE, syntax, ...)', () => {
    // NOT NULL on `name` already includes the column name in the
    // sqlite-wasm error; wrapping it would lose that context.
    let notNullErr: Error | null = null;
    try {
      execWithBinds(db, 'INSERT INTO t (id, name) VALUES (?, ?)', [1, null]);
    } catch (e) {
      notNullErr = e as Error;
    }
    expect(notNullErr?.message).toMatch(/NOT NULL/);
    expect(notNullErr?.message).not.toMatch(/SQLite bind failed/);

    // UNIQUE constraint: same — the original error names the index.
    execWithBinds(db, 'INSERT INTO t (id, name) VALUES (?, ?)', [2, 'alice']);
    let uniqueErr: Error | null = null;
    try {
      execWithBinds(db, 'INSERT INTO t (id, name) VALUES (?, ?)', [2, 'duplicate']);
    } catch (e) {
      uniqueErr = e as Error;
    }
    expect(uniqueErr?.message).toMatch(/UNIQUE/i);
    expect(uniqueErr?.message).not.toMatch(/SQLite bind failed/);
  });

  it('flags `undefined` proactively even though sqlite-wasm silently coerces it to NULL', () => {
    // sqlite-wasm 3.x quietly binds `undefined` as NULL — the same
    // silent-NULL trap that motivated this wrapper in the first place
    // (the original bug was an array passed as `opts` binding every
    // `?` to NULL; this is the per-element version of that). The
    // wrapper's pre-validation catches it before sqlite-wasm can hide
    // it, so an unintended undefined in a params array fails loudly
    // instead of writing the wrong row.
    let captured: Error | null = null;
    try {
      execWithBinds(
        db,
        'INSERT INTO t (id, name, score) VALUES (?, ?, ?)',
        [1, 'ok', undefined],
      );
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toMatch(/SQLite bind failed/);
    expect(captured?.message).toMatch(/params\[2\] = undefined/);
  });

  it('flags Date / Map / Set values that sqlite-wasm rejects as "object"', () => {
    // The most common production bind error — a row-shaped object
    // accidentally passed positionally, a Date that should have been
    // `.getTime()`, a Set from an upstream dedup that never got
    // unwrapped. The pre-validation pass flags all three; the SQL
    // snippet + index pinpoints which mapper is wrong.
    const cases: Array<[unknown, RegExp]> = [
      [new Date(0), /params\[1\]/],
      [new Map(), /params\[1\]/],
      [new Set(['a']), /params\[1\]/],
    ];
    for (const [value, regex] of cases) {
      let captured: Error | null = null;
      try {
        execWithBinds(
          db,
          'INSERT INTO t (id, name) VALUES (?, ?)',
          [Math.floor(Math.random() * 1e9), value],
        );
      } catch (e) {
        captured = e as Error;
      }
      expect(captured?.message, `for ${Object.prototype.toString.call(value)}`).toMatch(regex);
      expect(captured?.message, `for ${Object.prototype.toString.call(value)}`).toMatch(
        /SQLite bind failed/,
      );
    }
  });
});
