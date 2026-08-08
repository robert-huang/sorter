import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../../disposableCacheDb';
import {
  _resetPersistentToolsCacheForTesting,
  clearPersistentToolsCache,
  persistentCacheDelete,
  persistentCacheDeletePrefix,
  persistentCacheGet,
  persistentCacheSet,
  sweepExpiredPersistentCache,
  withPersistentTtlCache,
} from '../toolsPersistentCache';

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await _resetDisposableCacheDbForTesting();
  _resetPersistentToolsCacheForTesting();
});

describe('persistentCacheGet / persistentCacheSet', () => {
  it('round-trips a value through disposable IndexedDB', async () => {
    await persistentCacheSet('k1', { a: 1, b: 'two' }, 60_000);

    await expect(
      persistentCacheGet<{ a: number; b: string }>('k1'),
    ).resolves.toEqual({
      hit: true,
      value: { a: 1, b: 'two' },
    });
    expect(localStorage.getItem('tools-cache:k1')).toBeNull();
  });

  it('distinguishes missing and cached null values', async () => {
    await expect(persistentCacheGet('missing')).resolves.toEqual({
      hit: false,
    });
    await persistentCacheSet<null>('null-key', null, 60_000);
    await expect(persistentCacheGet<null>('null-key')).resolves.toEqual({
      hit: true,
      value: null,
    });
  });

  it('evicts expired entries on read', async () => {
    await persistentCacheSet('expiring', 'value', 60_000);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

    await expect(persistentCacheGet('expiring')).resolves.toEqual({
      hit: false,
    });
  });

  it('migrates valid legacy records and removes corrupt records', async () => {
    localStorage.setItem(
      'tools-cache:legacy',
      JSON.stringify({ value: { id: 1 }, expiresAt: Date.now() + 60_000 }),
    );
    localStorage.setItem('tools-cache:bad', '{not json');

    await expect(persistentCacheGet('legacy')).resolves.toEqual({
      hit: true,
      value: { id: 1 },
    });
    expect(localStorage.getItem('tools-cache:legacy')).toBeNull();
    expect(localStorage.getItem('tools-cache:bad')).toBeNull();
  });
});

describe('persistent cache deletion', () => {
  it('deletes a single key', async () => {
    await persistentCacheSet('one', 1, 60_000);
    await persistentCacheSet('two', 2, 60_000);
    await persistentCacheDelete('one');

    await expect(persistentCacheGet('one')).resolves.toEqual({ hit: false });
    await expect(persistentCacheGet<number>('two')).resolves.toEqual({
      hit: true,
      value: 2,
    });
  });

  it('deletes only keys matching the prefix', async () => {
    await persistentCacheSet('franchise:relations:1', 'a', 60_000);
    await persistentCacheSet('franchise:relations:2', 'b', 60_000);
    await persistentCacheSet('other:thing', 'c', 60_000);
    await persistentCacheDeletePrefix('franchise:relations:');

    await expect(
      persistentCacheGet('franchise:relations:1'),
    ).resolves.toEqual({ hit: false });
    await expect(
      persistentCacheGet('franchise:relations:2'),
    ).resolves.toEqual({ hit: false });
    await expect(persistentCacheGet<string>('other:thing')).resolves.toEqual({
      hit: true,
      value: 'c',
    });
  });

  it('sweeps expired entries without removing live records', async () => {
    await persistentCacheSet('stale', 'old', 1);
    await persistentCacheSet('fresh', 'new', 60_000);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2);

    await expect(sweepExpiredPersistentCache()).resolves.toBe(1);
    await expect(persistentCacheGet('fresh')).resolves.toEqual({
      hit: true,
      value: 'new',
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
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bust:true skips the cache and re-fetches', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new');
    await withPersistentTtlCache('k', 60_000, fetcher);

    await expect(
      withPersistentTtlCache('k', 60_000, fetcher, { bust: true }),
    ).resolves.toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches null and does not persist rejected fetches', async () => {
    const nullFetcher = vi.fn().mockResolvedValue(null);
    await withPersistentTtlCache('null', 60_000, nullFetcher);
    await expect(
      withPersistentTtlCache('null', 60_000, nullFetcher),
    ).resolves.toBeNull();
    expect(nullFetcher).toHaveBeenCalledOnce();

    const rejectedFetcher = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      withPersistentTtlCache('rejected', 60_000, rejectedFetcher),
    ).rejects.toThrow('boom');
    await expect(persistentCacheGet('rejected')).resolves.toEqual({
      hit: false,
    });
  });

  it('does not re-persist a request that started before an explicit clear', async () => {
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const request = withPersistentTtlCache('in-flight', 60_000, async () => {
      signalFetchStarted();
      await fetchReleased;
      return 'fresh response';
    });

    await fetchStarted;
    await clearPersistentToolsCache();
    releaseFetch();

    await expect(request).resolves.toBe('fresh response');
    await expect(persistentCacheGet('in-flight')).resolves.toEqual({
      hit: false,
    });
  });
});
