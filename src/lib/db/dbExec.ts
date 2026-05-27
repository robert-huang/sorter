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
 *
 * Diagnostic catch: sqlite-wasm's native `bind()` error is
 * `unsupported bind() argument type: <typeof>` with no SQL, no
 * param index, no value preview. The wrapper catches that exact
 * shape and re-throws with the SQL snippet, every non-bindable
 * param's index, and a short JSON-ish dump of its value so the
 * actual upstream bug (object slipping into a positional bind, a
 * Date, a stray `undefined`) is identifiable from a single stack.
 * Cost in the happy path is one try/catch frame.
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

/**
 * Mirror of sqlite-wasm's `bindOne` accept-list: scalar primitives
 * (string/number/bigint/boolean), `null`, and `Uint8Array` BLOBs.
 * Plain objects, arrays, Dates, Maps, Sets, and `undefined` all fail.
 */
function isBindable(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') {
    return true;
  }
  if (t === 'object' && v instanceof Uint8Array) return true;
  return false;
}

/**
 * Short, readable preview of a bind value for the diagnostic error.
 * Truncates long JSON to keep stack traces usable; falls back to
 * `Object.prototype.toString` for values JSON can't serialize
 * (cyclic refs, BigInts in objects, etc.).
 */
function describeBindable(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') {
    const s = v as string;
    return s.length > 80 ? `string("${s.slice(0, 77)}...")` : `string("${s}")`;
  }
  if (t === 'number' || t === 'bigint' || t === 'boolean') {
    return `${t}(${String(v)})`;
  }
  // typeof 'object' but not Uint8Array / null — the actual error case.
  const tag = Object.prototype.toString.call(v);
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return tag;
    return json.length > 120 ? `${tag} ${json.slice(0, 117)}...` : `${tag} ${json}`;
  } catch {
    return tag;
  }
}

/**
 * Build the diagnostic error for a non-bindable params array.
 * Extracted so both the pre-validation path and the post-hoc catch
 * (defense-in-depth against a future sqlite-wasm rule change) emit
 * the same shape.
 */
function makeBindDiagnostic(
  sql: string,
  params: readonly unknown[],
  bad: number[],
  cause?: unknown,
): Error {
  const sqlSnippet = sql.length > 240 ? `${sql.slice(0, 237)}...` : sql;
  const lines = bad.map((i) => `  params[${i}] = ${describeBindable(params[i])}`);
  const detail = bad.length > 0
    ? `Non-bindable params (${bad.length} of ${params.length}):\n${lines.join('\n')}`
    : `All ${params.length} params look scalar but sqlite-wasm still rejected them — version mismatch suspected.`;
  const causeMsg = cause instanceof Error
    ? `\nOriginal: ${cause.message}`
    : cause !== undefined ? `\nOriginal: ${String(cause)}` : '';
  const diag = new Error(
    `SQLite bind failed.\nSQL: ${sqlSnippet}\n${detail}${causeMsg}`,
  );
  if (cause !== undefined) {
    // Preserve the original stack chain so devtools "View source" still
    // points at the underlying bind frame, not just this wrapper.
    (diag as Error & { cause?: unknown }).cause = cause;
  }
  return diag;
}

export function execWithBinds(
  db: AnyDb,
  sql: string,
  params: readonly unknown[] | undefined,
): void {
  if (params === undefined) {
    db.exec(sql);
    return;
  }
  // Pre-validate before sqlite-wasm gets the array. We do this for
  // two reasons:
  //   1. sqlite-wasm silently coerces `undefined` to NULL — the
  //      same silent-NULL trap that motivated this wrapper in the
  //      first place. Pre-validation catches it deterministically.
  //   2. The diagnostic message can include EVERY bad param, not
  //      just the first one sqlite-wasm tripped on.
  // Cost is one linear pass over a tiny array — irrelevant.
  const bad: number[] = [];
  for (let i = 0; i < params.length; i++) {
    if (!isBindable(params[i])) bad.push(i);
  }
  if (bad.length > 0) {
    throw makeBindDiagnostic(sql, params, bad);
  }
  try {
    db.exec(sql, { bind: params });
  } catch (err) {
    // Belt-and-suspenders: if sqlite-wasm ever adds new bind rules we
    // didn't anticipate (BigInt out of range, blob type changes, …)
    // wrap that too. Other SQLite errors (NOT NULL, UNIQUE, FK,
    // syntax) already carry context, so leave those untouched.
    const original = err instanceof Error ? err.message : String(err);
    if (/unsupported bind\(\) argument type/i.test(original)) {
      throw makeBindDiagnostic(sql, params, [], err);
    }
    throw err;
  }
}
