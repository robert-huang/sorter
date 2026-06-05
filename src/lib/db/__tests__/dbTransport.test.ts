import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcRequest } from '../rpc';
import { TEST_SOURCE_ID } from '../testSource';
import { MockWorker, stubNavigatorLocks } from './mockDbWorker';

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
    stubNavigatorLocks();
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

  it('shutdownDbTransport posts shutdown and terminates the worker', async () => {
    const { openSourceDb, shutdownDbTransport } = await import('../client');

    await openSourceDb(TEST_SOURCE_ID);
    const worker = MockWorker.instances[0];
    shutdownDbTransport();

    expect(worker.terminated).toBe(true);
    expect(
      worker.postMessageCalls.some(
        (call) => (call as RpcRequest).type === 'shutdown',
      ),
    ).toBe(true);
  });

  it('buffers worker messages emitted before start installs the handler', async () => {
    const { DedicatedWorkerTransport } = await import('../dbTransport');
    const listeners = new Set<(event: MessageEvent) => void>();
    const worker = {
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'message') {
          listeners.add(listener);
          listener(
            new MessageEvent('message', {
              data: { type: 'ready', storageMode: 'opfs' },
            }),
          );
        }
      },
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;

    const transport = new DedicatedWorkerTransport(worker);
    const onMessage = vi.fn();

    transport.start(onMessage);

    expect(listeners.size).toBe(1);
    expect(onMessage).toHaveBeenCalledWith({ type: 'ready', storageMode: 'opfs' });
  });
});
