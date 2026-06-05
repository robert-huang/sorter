import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from '../rpc';
import { TEST_SOURCE_ID } from '../testSource';

type WorkerListener = (event: MessageEvent<RpcReply | WorkerReadyMessage>) => void;

const READY_DELAY_MS = 50;

class MockWorker {
  static instances: MockWorker[] = [];

  private readonly messageListeners = new Set<WorkerListener>();
  readonly postMessageCalls: unknown[] = [];

  constructor(
    public readonly scriptUrl: URL | string,
    public readonly options?: WorkerOptions,
  ) {
    MockWorker.instances.push(this);
    setTimeout(() => {
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
    setTimeout(() => {
      if (req.type === 'open') {
        this.emitToListeners({ id: req.id, ok: true, result: 2 });
      }
    }, 0);
  }

  private emitToListeners(data: RpcReply | WorkerReadyMessage): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

class MockSharedWorker {
  static instances: MockSharedWorker[] = [];

  constructor() {
    MockSharedWorker.instances.push(this);
    throw new Error('SharedWorker must not be used for the DB transport');
  }
}

describe('db transport', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWorker.instances = [];
    MockSharedWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
    vi.stubGlobal('SharedWorker', MockSharedWorker as unknown as typeof SharedWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses a dedicated Worker and does not construct SharedWorker', async () => {
    const { openSourceDb } = await import('../client');

    const result = await openSourceDb(TEST_SOURCE_ID);

    expect(MockWorker.instances).toHaveLength(1);
    expect(MockSharedWorker.instances).toHaveLength(0);
    expect(result.storageMode).toBe('opfs');
    expect(MockWorker.instances[0].postMessageCalls.length).toBeGreaterThan(0);
  });
});
