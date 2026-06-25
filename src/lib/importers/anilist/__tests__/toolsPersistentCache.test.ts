import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAvailabilityCache } from '../../../storage';
import {
  persistentCacheDelete,
  persistentCacheDeletePrefix,
  persistentCacheGet,
  persistentCacheSet,
  withPersistentTtlCache,
} from '../toolsPersistentCache';

beforeEach(() => {
  window.localStorage.clear();
  _resetAvailabilityCache();
});

describe('persistentCacheGet / persistentCacheSet', () => {
  it('round-trips a value through localStorage', () => {
    persistentCacheSet('k1', { a: 1, b: 'two' }, 60_000);
    expect(persistentCacheGet<{ a: number; b: string }>('k1')).toEqual({
      hit: true,
      value: { a: 1, b: 'two' },
    });
  });

  it('returns hit:false for a missing key', () => {
    expect(persistentCacheGet('missing')).toEqual({ hit: false });
  });

  it('treats a literal cached null as a real hit', () => {
    persistentCacheSet<null>('null-key', null, 60_000);
    expect(persistentCacheGet<null>('null-key')).toEqual({
      hit: true,
      value: null,
    });
  });

  it('evicts expired entries on read', () => {
    persistentCacheSet('expiring', 'value', 60_000);
    const future = Date.now() + 120_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      expect(persistentCacheGet('expiring')).toEqual({ hit: false });
      expect(window.localStorage.getItem('tools-cache:expiring')).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('treats corrupted JSON as a miss without throwing', () => {
    window.localStorage.setItem('tools-cache:bad', '{not json');
    expect(persistentCacheGet('bad')).toEqual({ hit: false });
  });
});

describe('persistentCacheDelete + DeletePrefix', () => {
  it('deletes a single key', () => {
    persistentCacheSet('one', 1, 60_000);
    persistentCacheSet('two', 2, 60_000);
    persistentCacheDelete('one');
    expect(persistentCacheGet('one')).toEqual({ hit: false });
    expect(persistentCacheGet<number>('two')).toEqual({ hit: true, value: 2 });
  });

  it('deletes only keys matching the prefix', () => {
    persistentCacheSet('franchise:relations:1', 'a', 60_000);
    persistentCacheSet('franchise:relations:2', 'b', 60_000);
    persistentCacheSet('other:thing', 'c', 60_000);
    persistentCacheDeletePrefix('franchise:relations:');
    expect(persistentCacheGet('franchise:relations:1')).toEqual({ hit: false });
    expect(persistentCacheGet('franchise:relations:2')).toEqual({ hit: false });
    expect(persistentCacheGet<string>('other:thing')).toEqual({
      hit: true,
      value: 'c',
    });
  });
});

describe('withPersistentTtlCache', () => {
  it('serves the second call from cache without invoking the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: 1, edges: [] });
    const first = await withPersistentTtlCache('k', 60_000, fetcher);
    const second = await withPersistentTtlCache('k', 60_000, fetcher);
    expect(first).toEqual({ id: 1, edges: [] });
    expect(second).toEqual({ id: 1, edges: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bust:true skips the cache and re-fetches', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new');
    await withPersistentTtlCache('k', 60_000, fetcher);
    const v = await withPersistentTtlCache('k', 60_000, fetcher, { bust: true });
    expect(v).toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches a null fetcher result and serves it next time without re-fetching', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    await withPersistentTtlCache('k', 60_000, fetcher);
    const v = await withPersistentTtlCache('k', 60_000, fetcher);
    expect(v).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not persist on fetcher rejection', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withPersistentTtlCache('k', 60_000, fetcher)).rejects.toThrow(
      'boom',
    );
    expect(persistentCacheGet('k')).toEqual({ hit: false });
  });

  it('prunes expired entries when a write hits quota, then retries', () => {
    persistentCacheSet('stale', 'old', 1);
    const future = Date.now() + 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(future);
    const originalSetItem = Storage.prototype.setItem;
    let setCalls = 0;
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        setCalls++;
        // First attempt fails (quota); subsequent calls (the removeItem
        // path doesn't go through setItem, then the retry) succeed.
        if (setCalls === 1) {
          throw new Error('QuotaExceededError');
        }
        originalSetItem.call(this, key, value);
      });

    try {
      persistentCacheSet('fresh', 'new', 60_000);
    } finally {
      setSpy.mockRestore();
      nowSpy.mockRestore();
    }

    // After the prune-and-retry path: the stale entry is gone and the
    // fresh entry made it in on the second setItem call.
    expect(window.localStorage.getItem('tools-cache:stale')).toBeNull();
    expect(window.localStorage.getItem('tools-cache:fresh')).not.toBeNull();
  });
});
