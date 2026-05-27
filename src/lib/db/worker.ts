/// <reference lib="webworker" />
import sqlite3InitModule, {
  type Database,
  type OpfsSAHPoolDatabase,
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
import type { DbRow, RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import { getSource } from './source-registry';
import { ensureTestSourceRegistered } from './testSource';

ensureTestSourceRegistered();
ensureAnilistSourceRegistered();

const OPFS_SAH_POOL_VFS = 'opfs-sahpool';

const dbs = new Map<string, Database>();
/**
 * Source ids whose DBs have already been migrated in this worker session.
 * Bumped here (rather than relying on callers to hit the `open` RPC first)
 * so the read-only RPCs (`exec` SELECT, `currentSchemaVersion`, etc.)
 * cannot observe a pre-migration DB if a UI surface skips `openSourceDb`
 * and goes straight to a read — see `getOrOpenDb` for the lazy-migrate
 * call.
 */
const migratedSources = new Set<string>();
let sqlite3: Sqlite3Static | null = null;
let sahPool: SAHPoolUtil | null = null;
let storageMode: 'opfs' | 'memory' = 'memory';

function postReady(): void {
  const msg: WorkerReadyMessage = { type: 'ready', storageMode };
  self.postMessage(msg);
}

function postReply(reply: RpcReply): void {
  self.postMessage(reply);
}

/** RPCs received before WASM/OPFS init finishes; drained once `sqlite3` is set. */
const pendingRpc: RpcRequest[] = [];

async function initSqlite(): Promise<void> {
  // Vitest runs WASM init quickly; a short delay makes init-race tests deterministic.
  if (import.meta.env.VITEST) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  sqlite3 = await (sqlite3InitModule as (config?: object) => ReturnType<typeof sqlite3InitModule>)({
    print: () => {},
    printErr: console.error,
    locateFile: () => wasmUrl,
  });

  if (isOpfsSecureContext()) {
    try {
      sahPool = await sqlite3.installOpfsSAHPoolVfs({
        name: OPFS_SAH_POOL_VFS,
        initialCapacity: 8,
      });
      storageMode = 'opfs';
    } catch {
      sahPool = null;
      storageMode = 'memory';
    }
  } else {
    storageMode = 'memory';
  }

  postReady();
  drainPendingRpc();
}

function drainPendingRpc(): void {
  const queued = pendingRpc.splice(0, pendingRpc.length);
  for (const req of queued) {
    void dispatchRpc(req);
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

// FK enforcement is a per-connection PRAGMA in SQLite — not persisted in the
// file — so every newly opened connection must turn it on, or `ON DELETE
// CASCADE` clauses (e.g. anilist's media → media_list_entry / media_studio /
// media_tag junctions) silently fail to fire. Kept here next to every open
// path so a future source that adds another open site can't accidentally
// skip it.
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
  // First touch of this source in this worker process: run pending
  // migrations exactly once. Previously this only happened in the `open`
  // RPC, which meant a read-only entry point (e.g. an `exec` SELECT
  // issued before openSourceDb had a chance to run) could observe a
  // fresh OPFS DB at version 0 and throw "no such table". Doing it here
  // closes that gap without re-running migrations on every call.
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
  // A fresh DB replaces the old one — drop the "already migrated" flag so
  // the next getOrOpenDb re-asserts schema support against the replacement.
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
    // The incoming bytes carry their own schema_version row, so when
    // they're already at the app's max version this is a no-op. When
    // they're behind (e.g. user upgrades the app, then pulls a Drive
    // blob that was last pushed from a not-yet-upgraded device), the
    // local DB needs to run any pending migrations before the next
    // query touches a column the new code expects. Without this the
    // chip / readQueries would explode on first use because we'd have
    // already marked the source as "migrated".
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
  // getOrOpenDb now runs assertDbSchemaSupported + migrate on first
  // touch, so handleOpen just returns the resolved schema version.
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
      // pullMerge requires both DBs on the unix VFS (see merge.ts), so we
      // export the OPFS-backed local to bytes, run the merge purely in
      // memory, and route the merged bytes back through replaceDb (which
      // knows how to import into the sahpool slot in OPFS mode).
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

async function dispatchRpc(req: RpcRequest): Promise<void> {
  const { id } = req;
  try {
    const result = await handleRpc(req);
    postReply({ id, ok: true, result });
  } catch (err) {
    const e = err as Error & { code?: string };
    postReply({
      id,
      ok: false,
      error: { message: e.message, code: e.code },
    });
  }
}

void initSqlite().catch((err: unknown) => {
  const e = err as Error;
  const message = e.message || 'SQLite worker init failed';
  const queued = pendingRpc.splice(0, pendingRpc.length);
  for (const req of queued) {
    postReply({ id: req.id, ok: false, error: { message } });
  }
});

self.addEventListener('message', (event: MessageEvent<RpcRequest>) => {
  const req = event.data;
  if (!sqlite3) {
    pendingRpc.push(req);
    return;
  }
  void dispatchRpc(req);
});
