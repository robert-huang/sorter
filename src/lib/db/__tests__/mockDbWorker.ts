import { vi } from 'vitest';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from '../rpc';

type WorkerListener = (event: MessageEvent<RpcReply | WorkerReadyMessage>) => void;

const READY_DELAY_MS = 50;

export class MockWorker {
  static instances: MockWorker[] = [];

  private readonly messageListeners = new Set<WorkerListener>();
  readonly postMessageCalls: unknown[] = [];
  rpcPostedBeforeReady = false;
  terminated = false;
  private readySent = false;

  constructor(
    public readonly scriptUrl: URL | string,
    public readonly options?: WorkerOptions,
  ) {
    MockWorker.instances.push(this);
    setTimeout(() => {
      this.readySent = true;
      this.emitToListeners({ type: 'ready', storageMode: 'opfs' });
    }, READY_DELAY_MS);
  }

  addEventListener(type: string, listener: WorkerListener | null): void {
    if (type === 'message' && typeof listener === 'function') {
      this.messageListeners.add(listener);
    }
  }

  postMessage(data: unknown): void {
    this.postMessageCalls.push(data);
    const req = data as RpcRequest;
    if (!this.readySent && 'type' in req) {
      this.rpcPostedBeforeReady = true;
    }

    setTimeout(() => {
      if (req.type === 'open') {
        this.emitToListeners({ id: req.id, ok: true, result: 2 });
      } else if (req.type === 'exec') {
        this.emitToListeners({ id: req.id, ok: true, result: [{ one: 1 }] });
      }
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emitToListeners(data: RpcReply | WorkerReadyMessage): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

export function stubNavigatorLocks(): void {
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, callback: () => Promise<void>) => callback(),
    },
  });
}
