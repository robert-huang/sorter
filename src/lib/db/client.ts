import { ensureAnilistSourceRegistered } from '../importers/anilist/anilistSource';
import { createDbTransport, type DbTransport } from './dbTransport';
import { emitNonPersistentEvent } from './opfs';
import type { StorageMode } from './opfs';
import type { DbRow, RpcReply, RpcRequest, SqlParam, WorkerReadyMessage } from './rpc';
import { ensureTestSourceRegistered } from './testSource';

ensureTestSourceRegistered();
ensureAnilistSourceRegistered();

const WORKER_DIED_MESSAGE = 'Worker died; retry your operation';

let transport: DbTransport | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
/** Resolves when the worker posts `{ type: 'ready' }` after WASM/OPFS init. */
let workerReady: Promise<StorageMode> | null = null;
let lastStorageHint: string | undefined;
let transportEpoch = 0;
let nonPersistentEventSent = false;

function rejectAllPending(reason: Error): void {
  for (const [, handlers] of pending) {
    handlers.reject(reason);
  }
  pending.clear();
}

function onWorkerDeath(): void {
  transport = null;
  workerReady = null;
  rejectAllPending(new Error(WORKER_DIED_MESSAGE));
}

function handleTransportMessage(data: RpcReply | WorkerReadyMessage): void {
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

function onWorkerReady(msg: WorkerReadyMessage, resolve: (mode: StorageMode) => void): void {
  lastStorageHint = msg.storageHint;
  if (msg.storageMode === 'memory') {
    console.warn(
      '[db] Using in-memory SQLite — imports will not persist across reloads.',
      msg.storageHint ?? '(no detail from worker; check the worker console in DevTools → Sources → workers)',
    );
  }
  maybeEmitNonPersistent(msg.storageMode);
  resolve(msg.storageMode);
}

function spawnTransport(): DbTransport {
  const epoch = ++transportEpoch;
  const t = createDbTransport();

  workerReady = new Promise<StorageMode>((resolve) => {
    t.start((data) => {
      if (epoch !== transportEpoch) {
        return;
      }
      if (data && typeof data === 'object' && 'type' in data && data.type === 'ready') {
        onWorkerReady(data, resolve);
        return;
      }
      handleTransportMessage(data);
    });
  });

  t.addEventListener('error', onWorkerDeath);
  t.addEventListener('messageerror', onWorkerDeath);

  return t;
}

function getTransport(): DbTransport {
  if (!transport) {
    transport = spawnTransport();
  }
  return transport;
}

async function waitForWorkerReady(): Promise<StorageMode> {
  getTransport();
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
    getTransport().post({ ...req, id } as RpcRequest);
  });
}

function maybeEmitNonPersistent(mode: StorageMode): void {
  if (mode === 'memory' && !nonPersistentEventSent) {
    nonPersistentEventSent = true;
    emitNonPersistentEvent();
  }
}

export function getLastStorageHint(): string | undefined {
  return lastStorageHint;
}

export async function openSourceDb(
  sourceId: string,
): Promise<{ schemaVersion: number; storageMode: StorageMode; storageHint?: string }> {
  const storageMode = await waitForWorkerReady();
  const schemaVersion = await rpc<number>({ type: 'open', args: { sourceId } });
  maybeEmitNonPersistent(storageMode);
  return { schemaVersion, storageMode, storageHint: lastStorageHint };
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
