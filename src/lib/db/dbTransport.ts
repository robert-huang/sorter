import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';

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

  constructor(scriptUrl: URL) {
    this.worker = new Worker(scriptUrl, { type: 'module' });
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

  constructor(scriptUrl: URL) {
    this.worker = new SharedWorker(scriptUrl, { type: 'module', name: 'sorter-db' });
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

function createDedicatedTransport(): DbTransport {
  return new DedicatedWorkerTransport(new URL('./worker.ts', import.meta.url));
}

/** Prefer SharedWorker when available so all tabs share one OPFS-backed DB. */
export function createDbTransport(options?: CreateDbTransportOptions): DbTransport {
  if (!options?.forceDedicated && typeof SharedWorker !== 'undefined') {
    try {
      return new SharedWorkerTransport(new URL('./sharedDbWorker.ts', import.meta.url));
    } catch {
      // Safari private mode / restricted contexts may throw on construction.
    }
  }
  return createDedicatedTransport();
}
