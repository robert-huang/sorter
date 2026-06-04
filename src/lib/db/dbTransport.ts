import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import DedicatedDbWorker from './worker.ts?worker';
import SharedDbWorker from './sharedDbWorker.ts?sharedworker';

export type WorkerMessage = RpcReply | WorkerReadyMessage;

export interface DbTransport {
  readonly usesSharedWorker: boolean;
  start(onMessage: (data: WorkerMessage) => void): void;
  post(req: RpcRequest): void;
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void;
}

export class DedicatedWorkerTransport implements DbTransport {
  readonly usesSharedWorker = false;
  private readonly worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
  }

  start(onMessage: (data: WorkerMessage) => void): void {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      onMessage(event.data);
    });
  }

  post(req: RpcRequest): void {
    this.worker.postMessage(req);
  }

  addEventListener(
    type: 'error' | 'messageerror',
    listener: () => void,
  ): void {
    this.worker.addEventListener(type, listener);
  }
}

export class SharedWorkerTransport implements DbTransport {
  readonly usesSharedWorker = true;
  private readonly worker: SharedWorker;

  constructor(worker: SharedWorker) {
    this.worker = worker;
    this.worker.port.start();
  }

  start(onMessage: (data: WorkerMessage) => void): void {
    this.worker.port.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      onMessage(event.data);
    });
  }

  post(req: RpcRequest): void {
    this.worker.port.postMessage(req);
  }

  addEventListener(
    type: 'error' | 'messageerror',
    listener: () => void,
  ): void {
    this.worker.addEventListener(type, listener);
    this.worker.port.addEventListener(type, listener);
  }
}

export type CreateDbTransportOptions = {
  /** When true, always use a per-tab dedicated worker (SharedWorker fallback). */
  forceDedicated?: boolean;
};

const SHARED_WORKER_NAME = 'sorter-db';

function createDedicatedTransport(): DbTransport {
  return new DedicatedWorkerTransport(new DedicatedDbWorker());
}

/** Prefer SharedWorker when available so all tabs share one OPFS-backed DB. */
export function createDbTransport(options?: CreateDbTransportOptions): DbTransport {
  if (!options?.forceDedicated && typeof SharedWorker !== 'undefined') {
    try {
      return new SharedWorkerTransport(new SharedDbWorker({ name: SHARED_WORKER_NAME }));
    } catch {
      // Safari private mode / restricted contexts may throw on construction.
    }
  }
  return createDedicatedTransport();
}
