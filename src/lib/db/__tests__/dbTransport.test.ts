import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from '../rpc';
import { TEST_SOURCE_ID } from '../testSource';

const READY_DELAY_MS = 50;

type PortListener = (event: MessageEvent<RpcReply | WorkerReadyMessage>) => void;

class MockMessagePort {
  private readonly listeners = new Set<PortListener>();
  readonly postMessageCalls: unknown[] = [];
  started = false;

  start(): void {
    this.started = true;
  }

  addEventListener(type: string, listener: PortListener | null): void {
    if (type === 'message' && typeof listener === 'function') {
      this.listeners.add(listener);
    }
  }

  postMessage(data: unknown): void {
    this.postMessageCalls.push(data);
    const req = data as RpcRequest;
    setTimeout(() => {
      if (req.type === 'open') {
        this.emit({ id: req.id, ok: true, result: 2 });
      }
    }, 0);
  }

  emit(data: RpcReply | WorkerReadyMessage): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class MockSharedWorker {
  static instances: MockSharedWorker[] = [];

  readonly port: MockMessagePort;
  readonly name: string;

  constructor(
    public readonly scriptUrl: URL | string,
    options?: { type?: string; name?: string },
  ) {
    this.name = options?.name ?? '';
    this.port = new MockMessagePort();
    MockSharedWorker.instances.push(this);
    setTimeout(() => {
      this.port.emit({ type: 'ready', storageMode: 'memory' });
    }, READY_DELAY_MS);
  }

  addEventListener(): void {
    // lifecycle hooks — no-op in mock
  }
}

describe('db transport', () => {
  beforeEach(() => {
    vi.resetModules();
    MockSharedWorker.instances = [];
    vi.stubGlobal('SharedWorker', MockSharedWorker as unknown as typeof SharedWorker);
    vi.stubGlobal('Worker', class {
      constructor() {
        throw new Error('Dedicated Worker should not be used when SharedWorker is available');
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses SharedWorker with name sorter-db when supported', async () => {
    const { openSourceDb } = await import('../client');

    await openSourceDb(TEST_SOURCE_ID);

    const sw = MockSharedWorker.instances[0];
    expect(sw).toBeDefined();
    expect(sw.name).toBe('sorter-db');
    expect(sw.port.started).toBe(true);
    expect(sw.port.postMessageCalls.length).toBeGreaterThan(0);
  });
});
