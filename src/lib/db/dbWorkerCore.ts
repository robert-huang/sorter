/**
 * Shared SQLite + OPFS logic for dedicated and SharedWorker DB sessions.
 * Entry points (`worker.ts`, `sharedDbWorker.ts`) wire message ports only.
 */

import sqlite3InitModule, {
  OpfsSAHPoolDatabase,
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { ensureAnilistSourceRegistered } from '../importers/anilist/anilistSource';
import { execWithBinds } from './dbExec';
import { openDbFromBytes, serializeDb } from './dbBytes';
import {
  assertDbSchemaSupported,
  currentVersion,
  migrate,
} from './migration-runner';
import { pullMerge, peekRemoteSchemaVersion } from './merge';
import { isOpfsSecureContext } from './opfs';
import type { StorageMode } from './opfs';
import type { DbRow, RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import { getSource } from './source-registry';
import { ensureTestSourceRegistered } from './testSource';

ensureTestSourceRegistered();
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

async function initOpfsStorage(s3: Sqlite3Static): Promise<boolean> {
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
      const probe = new OpfsSAHPoolDatabase('/.sorter-opfs-probe.sqlite');
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
      `only one worker per tab can hold the OPFS pool when not using SharedWorker.`;
    return false;
  }
}

export function isSqliteReady(): boolean {
  return sqlite3 !== null;
}

export function failAllPending(message: string): void {
  const queued = pendingRpc.splice(0, pendingRpc.length);
  for (const { req, post } of queued) {
    post({ id: req.id, ok: false, error: { message } });
  }
}

export async function initDbWorker(): Promise<StorageMode> {
  if (import.meta.env.VITEST) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  storageHint = undefined;

  sqlite3 = await (sqlite3InitModule as (config?: object) => ReturnType<typeof sqlite3InitModule>)({
    print: () => {},
    printErr: console.error,
    locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : file),
  });

  if (!isOpfsSecureContext()) {
    storageMode = 'memory';
    storageHint =
      'This page is not a secure context. Use https:// or http://localhost (not plain http on a LAN IP).';
    console.warn('[db worker]', storageHint);
  } else if (await initOpfsStorage(sqlite3)) {
    storageMode = 'opfs';
  } else {
    sahPool = null;
    storageMode = 'memory';
    console.warn('[db worker] Falling back to in-memory SQLite.', storageHint);
  }

  drainPendingRpc();
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
  const DbClass: typeof OpfsSAHPoolDatabase | undefined = sahPool?.OpfsSAHPoolDb;
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

async function replaceDb(sourceId: string, bytes: Uint8Array): Promise<Database> {
  closeDb(sourceId);
  const s3 = requireSqlite();
  const source = getSource(sourceId);

  if (storageMode === 'opfs' && sahPool) {
    const filename = opfsFilename(sourceId);
    await sahPool.importDb(filename, bytes);
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

/** Queue an RPC for serialized execution on this worker session. */
export function queueRpc(req: RpcRequest, post: WorkerPost): void {
  if (!sqlite3) {
    pendingRpc.push({ req, post });
    return;
  }
  void enqueueRpc(() => dispatchRpc(req, post));
}
