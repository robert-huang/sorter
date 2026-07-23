/**
 * SQLite + OPFS logic for the dedicated DB worker (`worker.ts` wires messages only).
 */

import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import { ensureAnilistSourceRegistered } from '../importers/anilist/anilistSource';
import { execWithBinds } from './dbExec';
import { openDbFromBytes, serializeDb } from './dbBytes';
import {
  assertDbSchemaSupported,
  currentVersion,
  migrate,
} from './migration-runner';
import { pullMerge, peekRemoteSchemaVersion } from './merge';
import { canUseOpfsSahPool, describeOpfsBlockedReason } from './opfs';
import type { StorageMode } from './opfs';
import { OPFS_INIT_MAX_ATTEMPTS, withOpfsInstallRetry } from './opfsInstallRetry';
import { locateSqliteFile } from './sqliteLocateFile';
import type { DbRow, RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import { getSource } from './source-registry';

ensureAnilistSourceRegistered();

const OPFS_SAH_POOL_VFS = 'opfs-sahpool';

export type WorkerPost = (msg: RpcReply | WorkerReadyMessage) => void;

type PendingRpc = { req: RpcRequest; post: WorkerPost };

const dbs = new Map<string, Database>();
const migratedSources = new Set<string>();
let sqlite3: Sqlite3Static | null = null;
let sahPool: SAHPoolUtil | null = null;
let storageMode: StorageMode = 'memory';
let storageHint: string | undefined;
/** False until WASM + storage backend selection finish — not merely `sqlite3 !== null`. */
let workerInitComplete = false;
let initPromise: Promise<StorageMode> | null = null;

/** Serializes all RPC handlers — required when multiple tabs share one worker. */
let rpcChain = Promise.resolve();

const pendingRpc: PendingRpc[] = [];

function enqueueRpc<T>(fn: () => Promise<T>): Promise<T> {
  const next = rpcChain.then(fn, fn);
  rpcChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function getStorageMode(): StorageMode {
  return storageMode;
}

export function getStorageHint(): string | undefined {
  return storageHint;
}

export function buildReadyMessage(): WorkerReadyMessage {
  return {
    type: 'ready',
    storageMode,
    ...(storageHint ? { storageHint } : {}),
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tryInstallOpfsOnce(s3: Sqlite3Static): Promise<boolean> {
  sahPool = null;
  try {
    sahPool = await s3.installOpfsSAHPoolVfs({
      name: OPFS_SAH_POOL_VFS,
      initialCapacity: 8,
    });
    return true;
  } catch (err) {
    const message = formatError(err);
    console.warn(`[db worker] OPFS SAH pool install failed: ${message}`, err);

    try {
      const probe = new s3.oo1.DB('/.sorter-opfs-probe.sqlite', 'c', OPFS_SAH_POOL_VFS);
      probe.exec('SELECT 1');
      probe.close();
      sahPool = null;
      console.warn('[db worker] Reusing existing OPFS SAH pool VFS in this worker.');
      return true;
    } catch (probeErr) {
      console.warn('[db worker] OPFS SAH pool probe failed:', probeErr);
    }

    storageHint =
      `OPFS install failed (${message}). If another Sorter tab is open, close it and reload — ` +
      `only one page at a time can hold the OPFS SAH pool.`;
    return false;
  }
}

async function initOpfsStorage(s3: Sqlite3Static): Promise<boolean> {
  if (!canUseOpfsSahPool()) {
    storageHint = describeOpfsBlockedReason();
    console.warn('[db worker]', storageHint);
    return false;
  }

  let attempt = 0;
  const installed = await withOpfsInstallRetry(async () => {
    attempt += 1;
    if (attempt > 1) {
      console.warn(
        `[db worker] OPFS pool busy (likely another page releasing it), retry ${attempt}/${OPFS_INIT_MAX_ATTEMPTS}…`,
      );
    }
    return tryInstallOpfsOnce(s3);
  });

  return installed;
}

/** Close all open DB handles so OPFS sync access handles are released before worker termination. */
export function shutdownDbWorker(): void {
  for (const sourceId of [...dbs.keys()]) {
    closeDb(sourceId);
  }
}

/** True when init finished (success or fallback); safe to run RPCs and post `ready`. */
export function isSqliteReady(): boolean {
  return workerInitComplete;
}

export function failAllPending(message: string): void {
  const queued = pendingRpc.splice(0, pendingRpc.length);
  for (const { req, post } of queued) {
    post({ id: req.id, ok: false, error: { message } });
  }
}

export async function initDbWorker(): Promise<StorageMode> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = runInitDbWorker();
  return initPromise;
}

async function runInitDbWorker(): Promise<StorageMode> {
  storageHint = undefined;
  storageMode = 'memory';
  sahPool = null;

  try {
    if (import.meta.env.VITEST) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    sqlite3 = await (sqlite3InitModule as (config?: object) => ReturnType<typeof sqlite3InitModule>)({
      print: () => {},
      printErr: console.error,
      locateFile: locateSqliteFile,
    });

    if (await initOpfsStorage(sqlite3)) {
      storageMode = 'opfs';
    } else {
      sahPool = null;
      storageMode = 'memory';
      console.warn('[db worker] Falling back to in-memory SQLite.', storageHint);
    }
  } catch (err) {
    sqlite3 = null;
    sahPool = null;
    storageMode = 'memory';
    storageHint = `SQLite worker init failed: ${formatError(err)}`;
    console.error('[db worker]', storageHint, err);
  } finally {
    workerInitComplete = true;
    drainPendingRpc();
  }

  return storageMode;
}

function drainPendingRpc(): void {
  const queued = pendingRpc.splice(0, pendingRpc.length);
  for (const { req, post } of queued) {
    void enqueueRpc(() => dispatchRpc(req, post));
  }
}

function requireSqlite(): Sqlite3Static {
  if (!sqlite3) {
    throw new Error('SQLite worker not initialized');
  }
  return sqlite3;
}

function opfsFilename(sourceId: string): string {
  return `/${sourceId}.sqlite`;
}

function dbFilename(sourceId: string): string {
  return storageMode === 'opfs' ? opfsFilename(sourceId) : `/${sourceId}-mem.sqlite`;
}

function openOpfsDb(filename: string): Database {
  const s3 = requireSqlite();
  const DbClass = sahPool?.OpfsSAHPoolDb;
  if (DbClass) {
    return new DbClass(filename);
  }
  return new s3.oo1.DB(filename, 'c', OPFS_SAH_POOL_VFS);
}

function enableForeignKeys(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
}

function openDb(sourceId: string): Database {
  const s3 = requireSqlite();
  const filename = dbFilename(sourceId);
  const db = storageMode === 'opfs' ? openOpfsDb(filename) : new s3.oo1.DB(filename, 'c');
  enableForeignKeys(db);
  return db;
}

function getOrOpenDb(sourceId: string): Database {
  let db = dbs.get(sourceId);
  if (!db || !db.isOpen()) {
    db = openDb(sourceId);
    dbs.set(sourceId, db);
  }
  if (!migratedSources.has(sourceId)) {
    const source = getSource(sourceId);
    assertDbSchemaSupported(db, source);
    migrate(db, source);
    migratedSources.add(sourceId);
  }
  return db;
}

function closeDb(sourceId: string): void {
  const db = dbs.get(sourceId);
  if (db?.isOpen()) {
    db.close();
  }
  dbs.delete(sourceId);
  migratedSources.delete(sourceId);
}

async function importBytesToOpfsFile(
  s3: Sqlite3Static,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  if (sahPool) {
    await sahPool.importDb(filename, bytes);
    return;
  }
  const db = new s3.oo1.DB(filename, 'c', OPFS_SAH_POOL_VFS);
  try {
    const { wasm, capi } = s3;
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
      throw new Error(`sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`);
    }
  } finally {
    db.close();
  }
}

async function replaceDb(sourceId: string, bytes: Uint8Array): Promise<Database> {
  closeDb(sourceId);
  const s3 = requireSqlite();
  const source = getSource(sourceId);

  if (storageMode === 'opfs') {
    const filename = opfsFilename(sourceId);
    await importBytesToOpfsFile(s3, filename, bytes);
    const db = openOpfsDb(filename);
    enableForeignKeys(db);
    assertDbSchemaSupported(db, source);
    dbs.set(sourceId, db);
    migrate(db, source);
    migratedSources.add(sourceId);
    return db;
  }

  const db = openDbFromBytes(s3, bytes);
  enableForeignKeys(db);
  assertDbSchemaSupported(db, source);
  dbs.set(sourceId, db);
  migrate(db, source);
  migratedSources.add(sourceId);
  return db;
}

function handleOpen(sourceId: string): number {
  const db = getOrOpenDb(sourceId);
  return currentVersion(db);
}

function handleExec(
  sourceId: string,
  sql: string,
  params?: import('./rpc').SqlParam[],
): DbRow[] {
  const db = getOrOpenDb(sourceId);
  const trimmed = sql.trim().toLowerCase();
  const isSelect = trimmed.startsWith('select') || trimmed.startsWith('pragma');

  if (isSelect) {
    return params !== undefined
      ? (db.selectObjects(sql, params as never) as DbRow[])
      : (db.selectObjects(sql) as DbRow[]);
  }

  execWithBinds(db, sql, params);
  return [];
}

function handleExecBatch(
  sourceId: string,
  statements: Array<{ sql: string; params?: import('./rpc').SqlParam[] }>,
): void {
  const db = getOrOpenDb(sourceId);
  db.transaction(() => {
    for (const { sql, params } of statements) {
      execWithBinds(db, sql, params);
    }
  });
}

async function handleRpc(req: RpcRequest): Promise<unknown> {
  const s3 = requireSqlite();

  switch (req.type) {
    case 'open':
      return handleOpen(req.args.sourceId);
    case 'exec':
      return handleExec(req.args.sourceId, req.args.sql, req.args.params);
    case 'execBatch':
      handleExecBatch(req.args.sourceId, req.args.statements);
      return undefined;
    case 'pullMerge': {
      const local = getOrOpenDb(req.args.sourceId);
      const localBytes = serializeDb(s3, local);
      const mergedBytes = pullMerge(
        s3,
        localBytes,
        req.args.sourceId,
        req.args.remoteBytes,
      );
      await replaceDb(req.args.sourceId, mergedBytes);
      return mergedBytes;
    }
    case 'exportBytes': {
      const db = getOrOpenDb(req.args.sourceId);
      return serializeDb(s3, db);
    }
    case 'importBytes': {
      await replaceDb(req.args.sourceId, req.args.bytes);
      return undefined;
    }
    case 'currentSchemaVersion': {
      const db = getOrOpenDb(req.args.sourceId);
      return currentVersion(db);
    }
    case 'peekRemoteSchemaVersion':
      return peekRemoteSchemaVersion(s3, req.args.remoteBytes);
    case 'shutdown':
      shutdownDbWorker();
      return undefined;
    default: {
      const _exhaustive: never = req;
      throw new Error(`Unknown RPC type: ${(_exhaustive as RpcRequest).type}`);
    }
  }
}

async function dispatchRpc(req: RpcRequest, post: WorkerPost): Promise<void> {
  const { id } = req;
  try {
    const result = await handleRpc(req);
    post({ id, ok: true, result });
  } catch (err) {
    const e = err as Error & { code?: string };
    post({
      id,
      ok: false,
      error: { message: e.message, code: e.code },
    });
  }
}

function isRpcRequest(data: unknown): data is RpcRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof (data as RpcRequest).id === 'number' &&
    'type' in data &&
    typeof (data as RpcRequest).type === 'string'
  );
}

/** Queue an RPC for serialized execution on this worker session. */
export function queueRpc(req: RpcRequest, post: WorkerPost): void {
  if (!isRpcRequest(req)) {
    console.warn('[db worker] Ignoring invalid RPC message');
    return;
  }
  if (req.type === 'shutdown') {
    shutdownDbWorker();
    return;
  }
  if (!workerInitComplete) {
    pendingRpc.push({ req, post });
    return;
  }
  void enqueueRpc(() => dispatchRpc(req, post));
}
