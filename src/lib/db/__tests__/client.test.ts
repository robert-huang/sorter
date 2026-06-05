import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWorker, stubNavigatorLocks } from './mockDbWorker';
import { TEST_SOURCE_ID } from '../testSource';

describe('db client worker init', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWorker.instances = [];
    stubNavigatorLocks();
    vi.stubGlobal('SharedWorker', undefined);
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
