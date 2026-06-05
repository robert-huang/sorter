import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPFS_LOCK_NAME, queryIsOpfsLockHeld } from '../opfsLock';

describe('queryIsOpfsLockHeld', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when another client holds the OPFS lock', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        query: async () => ({
          held: [{ name: OPFS_LOCK_NAME }],
          pending: [],
        }),
      },
    });
    await expect(queryIsOpfsLockHeld()).resolves.toBe(true);
  });

  it('returns false when the OPFS lock is free', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        query: async () => ({ held: [], pending: [] }),
      },
    });
    await expect(queryIsOpfsLockHeld()).resolves.toBe(false);
  });
});
