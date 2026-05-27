import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from '../rpc';
import { TEST_SOURCE_ID } from '../testSource';

type WorkerListener = (event: MessageEvent<RpcReply | WorkerReadyMessage>) => void;

const READY_DELAY_MS = 50;

class MockWorker {
  static instances: MockWorker[] = [];

  private readonly messageListeners = new Set<WorkerListener>();
  readonly postMessageCalls: unknown[] = [];
  rpcPostedBeforeReady = false;
  private readySent = false;

  constructor(
    public readonly scriptUrl: URL | string,
    public readonly options?: WorkerOptions,
  ) {
    MockWorker.instances.push(this);
    setTimeout(() => {
      this.readySent = true;
      this.emitToListeners({ type: 'ready', storageMode: 'memory' });
    }, READY_DELAY_MS);
  }

  addEventListener(type: string, listener: WorkerListener | null): void {
    if (type === 'message' && typeof listener === 'function') {
      this.messageListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: WorkerListener | null): void {
    if (type === 'message' && typeof listener === 'function') {
      this.messageListeners.delete(listener);
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

  private emitToListeners(data: RpcReply | WorkerReadyMessage): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

describe('db client worker init', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not post RPC until the worker ready handshake completes', async () => {
    const { openSourceDb } = await import('../client');

    await openSourceDb(TEST_SOURCE_ID);

    const w = MockWorker.instances[0];
    expect(w).toBeDefined();
    expect(w.rpcPostedBeforeReady).toBe(false);
    expect(w.postMessageCalls.length).toBeGreaterThan(0);
  });

  it('openSourceDb and exec succeed when fired before worker ready', async () => {
    const { exec, openSourceDb } = await import('../client');

    const openPromise = openSourceDb(TEST_SOURCE_ID);
    const execPromise = exec(TEST_SOURCE_ID, 'SELECT 1 AS one');
    const [openResult, rows] = await Promise.all([openPromise, execPromise]);

    expect(openResult.schemaVersion).toBe(2);
    expect(rows).toEqual([{ one: 1 }]);
    expect(MockWorker.instances[0].rpcPostedBeforeReady).toBe(false);
  });
});
