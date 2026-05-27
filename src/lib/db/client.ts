import { ensureAnilistSourceRegistered } from '../importers/anilist/anilistSource';
import { emitNonPersistentEvent } from './opfs';
import type { DbRow, RpcReply, RpcRequest, SqlParam, WorkerReadyMessage } from './rpc';
import { ensureTestSourceRegistered } from './testSource';

ensureTestSourceRegistered();
ensureAnilistSourceRegistered();

const WORKER_DIED_MESSAGE = 'Worker died; retry your operation';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
/** Resolves when the worker posts `{ type: 'ready' }` after WASM/OPFS init. */
let workerReady: Promise<'opfs' | 'memory'> | null = null;
let nonPersistentEventSent = false;

function rejectAllPending(reason: Error): void {
  for (const [, handlers] of pending) {
    handlers.reject(reason);
  }
  pending.clear();
}

function onWorkerDeath(): void {
  worker = null;
  workerReady = null;
  rejectAllPending(new Error(WORKER_DIED_MESSAGE));
}

function handleWorkerMessage(event: MessageEvent<RpcReply | WorkerReadyMessage>): void {
  const data = event.data;
  if (data && typeof data === 'object' && 'type' in data && data.type === 'ready') {
    return;
  }

  const reply = data as RpcReply;
  const handlers = pending.get(reply.id);
  if (!handlers) {
    return;
  }
  pending.delete(reply.id);

  if (reply.ok) {
    handlers.resolve(reply.result);
  } else {
    const err = new Error(reply.error.message) as Error & { code?: string };
    if (reply.error.code) {
      err.code = reply.error.code;
    }
    handlers.reject(err);
  }
}

function attachWorkerLifecycle(w: Worker): void {
  w.addEventListener('message', handleWorkerMessage);
  w.addEventListener('error', onWorkerDeath);
  w.addEventListener('messageerror', onWorkerDeath);
}

function bindWorkerReady(w: Worker): void {
  workerReady = new Promise<'opfs' | 'memory'>((resolve) => {
    const onReady = (e: MessageEvent<RpcReply | WorkerReadyMessage>) => {
      if (e.data && typeof e.data === 'object' && 'type' in e.data && e.data.type === 'ready') {
        w.removeEventListener('message', onReady);
        // Fire the memory-mode banner event the instant the worker
        // reports it couldn't claim OPFS — independent of whether the
        // caller went through openSourceDb. Without this, a tab that
        // only ever issues raw `exec` reads (which is the case for
        // AnilistStartMode's cache-hint lookups) would silently use
        // an empty memory DB and the user would have no idea why
        // their cache is missing.
        maybeEmitNonPersistent(e.data.storageMode);
        resolve(e.data.storageMode);
      }
    };
    w.addEventListener('message', onReady);
  });
}

function spawnWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  attachWorkerLifecycle(w);
  bindWorkerReady(w);
  return w;
}

function getWorker(): Worker {
  if (!worker) {
    worker = spawnWorker();
  }
  return worker;
}

async function waitForWorkerReady(): Promise<'opfs' | 'memory'> {
  getWorker();
  return workerReady!;
}

async function rpc<T>(req: Omit<RpcRequest, 'id'>): Promise<T> {
  await waitForWorkerReady();
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ ...req, id } as RpcRequest);
  });
}

function maybeEmitNonPersistent(mode: 'opfs' | 'memory'): void {
  if (mode === 'memory' && !nonPersistentEventSent) {
    nonPersistentEventSent = true;
    emitNonPersistentEvent();
  }
}

export async function openSourceDb(
  sourceId: string,
): Promise<{ schemaVersion: number; storageMode: 'opfs' | 'memory' }> {
  const storageMode = await waitForWorkerReady();
  const schemaVersion = await rpc<number>({ type: 'open', args: { sourceId } });
  maybeEmitNonPersistent(storageMode);
  return { schemaVersion, storageMode };
}

export async function exec(
  sourceId: string,
  sql: string,
  params?: SqlParam[],
): Promise<DbRow[]> {
  return rpc<DbRow[]>({ type: 'exec', args: { sourceId, sql, params } });
}

export async function execBatch(
  sourceId: string,
  statements: Array<{ sql: string; params?: SqlParam[] }>,
): Promise<void> {
  await rpc<void>({ type: 'execBatch', args: { sourceId, statements } });
}

export async function pullMerge(
  sourceId: string,
  remoteBytes: Uint8Array,
): Promise<Uint8Array> {
  return rpc<Uint8Array>({ type: 'pullMerge', args: { sourceId, remoteBytes } });
}

export async function exportBytes(sourceId: string): Promise<Uint8Array> {
  return rpc<Uint8Array>({ type: 'exportBytes', args: { sourceId } });
}

export async function importBytes(sourceId: string, bytes: Uint8Array): Promise<void> {
  await rpc<void>({ type: 'importBytes', args: { sourceId, bytes } });
}

export async function currentSchemaVersion(sourceId: string): Promise<number> {
  return rpc<number>({ type: 'currentSchemaVersion', args: { sourceId } });
}

export async function peekRemoteSchemaVersion(remoteBytes: Uint8Array): Promise<number> {
  return rpc<number>({ type: 'peekRemoteSchemaVersion', args: { remoteBytes } });
}
