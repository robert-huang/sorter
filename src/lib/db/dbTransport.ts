import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';
import DedicatedDbWorker from './worker.ts?worker';

export type WorkerMessage = RpcReply | WorkerReadyMessage;

export interface DbTransport {
  start(onMessage: (data: WorkerMessage) => void): void;
  post(req: RpcRequest): void;
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void;
  terminate(): void;
}

export class DedicatedWorkerTransport implements DbTransport {
  private readonly worker: Worker;
  private onMessage: ((data: WorkerMessage) => void) | null = null;
  private readonly earlyMessages: WorkerMessage[] = [];

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      if (this.onMessage) {
        this.onMessage(event.data);
      } else {
        this.earlyMessages.push(event.data);
      }
    });
  }

  start(onMessage: (data: WorkerMessage) => void): void {
    this.onMessage = onMessage;
    for (const data of this.earlyMessages.splice(0)) {
      onMessage(data);
    }
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

  terminate(): void {
    this.worker.terminate();
  }
}

/** One dedicated worker per page — required for OPFS sync access handles (SAH pool). */
export function createDbTransport(): DbTransport {
  return new DedicatedWorkerTransport(new DedicatedDbWorker());
}
