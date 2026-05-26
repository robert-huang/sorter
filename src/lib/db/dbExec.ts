/**
 * Tiny wrapper for sqlite-wasm's `db.exec(sql, opts)` that pins the
 * binding contract.
 *
 * sqlite-wasm's `exec(sql, opts)` parses the second argument as an
 * options object. If you pass the params array directly
 * (`db.exec(sql, [1, 'foo'])`), sqlite-wasm treats `[1, 'foo']` as
 * the opts object, finds no `.bind` property, and silently binds
 * every `?` placeholder to NULL — no error, just wrong data. This
 * has bitten the importer (every INSERT through the worker bound
 * NULL into NOT NULL columns), so anything that runs `exec` with
 * params MUST route through here.
 *
 * SELECTs are unaffected because they go through `db.selectObjects(
 * sql, bind)` where the second arg IS the bind array directly.
 */

// We intentionally type the db param loosely so this works against
// both the real `Database` from `@sqlite.org/sqlite-wasm` and any
// duck-typed test stub. The package's own `exec` overloads are
// strict about the `bind` shape; we narrow internally instead.
type AnyDb = {
  // Either overload — runtime is the same `exec(...)`.
  exec(sql: string): unknown;
  exec(sql: string, opts: unknown): unknown;
};

export function execWithBinds(
  db: AnyDb,
  sql: string,
  params: readonly unknown[] | undefined,
): void {
  if (params !== undefined) {
    db.exec(sql, { bind: params });
  } else {
    db.exec(sql);
  }
}
