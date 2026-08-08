import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDisposableCacheDbForTesting,
  clearDisposableCacheNamespace,
  enforceDisposableCacheBudget,
  getDisposableCacheStats,
  putDisposableCache,
  readDisposableCache,
  sweepExpiredDisposableCache,
} from '../disposableCacheDb';

beforeEach(async () => {
  vi.useRealTimers();
  await _resetDisposableCacheDbForTesting();
});

describe('disposable cache database', () => {
  it('persists values and distinguishes a cached null from a miss', async () => {
    await putDisposableCache('tools', 'null-result', null, {
      expiresAt: Date.now() + 60_000,
    });

    expect(await readDisposableCache('tools', 'null-result')).toEqual({
      hit: true,
      value: null,
    });
    expect(await readDisposableCache('tools', 'missing')).toEqual({
      hit: false,
    });
  });

  it('proactively removes expired records', async () => {
    await putDisposableCache('tools', 'expired', { id: 1 }, {
      expiresAt: Date.now() - 1,
    });
    await putDisposableCache('tools', 'live', { id: 2 }, {
      expiresAt: Date.now() + 60_000,
    });

    expect(await sweepExpiredDisposableCache('tools')).toBe(1);
    expect(await readDisposableCache('tools', 'expired')).toEqual({
      hit: false,
    });
    expect(await readDisposableCache('tools', 'live')).toEqual({
      hit: true,
      value: { id: 2 },
    });
  });

  it('evicts least-recently-used records while preserving retained keys', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await putDisposableCache('images', 'old', 'old', { byteLength: 10 });
    now = 2_000;
    await putDisposableCache('images', 'retained', 'retained', {
      byteLength: 10,
    });
    now = 3_000;
    await putDisposableCache('images', 'new', 'new', { byteLength: 10 });

    const removed = await enforceDisposableCacheBudget('images', {
      maxEntries: 2,
      maxBytes: 20,
      retainKeys: new Set(['retained']),
    });

    expect(removed).toEqual(['old']);
    expect(await getDisposableCacheStats('images')).toEqual({
      entries: 2,
      bytes: 20,
    });
  });

  it('surfaces explicit cleanup failures instead of reporting success', async () => {
    await _resetDisposableCacheDbForTesting();
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(clearDisposableCacheNamespace('tools')).rejects.toThrow(
        'IndexedDB is unavailable.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
