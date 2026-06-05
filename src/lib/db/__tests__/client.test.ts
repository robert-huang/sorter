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
    vi.restoreAllMocks();
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

  it('does not block on OPFS lock when another tab holds it', async () => {
    stubNavigatorLocks({ lockHeld: true });
    const { isOpfsLockContendedByOtherTab, openSourceDb } = await import('../client');

    await expect(
      Promise.race([
        openSourceDb(TEST_SOURCE_ID),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for openSourceDb')), 500);
        }),
      ]),
    ).resolves.toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        opfsLockContendedByOtherTab: true,
      }),
    );

    expect(MockWorker.instances[0]).toBeDefined();
    expect(isOpfsLockContendedByOtherTab()).toBe(true);
  });

  it('reports no OPFS lock contention when this tab acquires the lock', async () => {
    const { isOpfsLockContendedByOtherTab, openSourceDb } = await import('../client');

    await expect(openSourceDb(TEST_SOURCE_ID)).resolves.toEqual(
      expect.objectContaining({ opfsLockContendedByOtherTab: false }),
    );
    expect(isOpfsLockContendedByOtherTab()).toBe(false);
  });

  it('continues when navigator.locks.request throws (no ifAvailable support)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const request = vi.fn(() => {
      throw new TypeError('callback is not a function');
    });
    vi.stubGlobal('navigator', {
      locks: {
        query: async () => ({ held: [], pending: [] }),
        request,
      },
    });
    const { openSourceDb } = await import('../client');

    await expect(
      Promise.race([
        openSourceDb(TEST_SOURCE_ID),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for openSourceDb')), 500);
        }),
      ]),
    ).resolves.toEqual(expect.objectContaining({ schemaVersion: 2 }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[db] OPFS lock request threw; continuing without lock',
      expect.any(TypeError),
    );
  });
});
