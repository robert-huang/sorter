import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import DedicatedDbWorker from './worker.ts?worker';

export type WorkerMessage = RpcReply | WorkerReadyMessage;

export interface DbTransport {
  start(onMessage: (data: WorkerMessage) => void): void;
  post(req: RpcRequest): void;
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void;
}

export class DedicatedWorkerTransport implements DbTransport {
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

/** One dedicated worker per page — required for OPFS sync access handles (SAH pool). */
export function createDbTransport(): DbTransport {
  return new DedicatedWorkerTransport(new DedicatedDbWorker());
}
