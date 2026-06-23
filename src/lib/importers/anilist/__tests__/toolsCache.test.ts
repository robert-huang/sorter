import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOLS_CACHE_TTL_MS,
  _clearToolsCacheForTesting,
  toolsCacheGet,
  toolsCacheSet,
  withToolsCache,
} from '../toolsCache';

describe('toolsCache', () => {
  beforeEach(async () => {
    await _clearToolsCacheForTesting();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await _clearToolsCacheForTesting();
  });

  it('returns null for missing keys', async () => {
    expect(await toolsCacheGet('missing')).toBeNull();
  });

  it('round-trips values before TTL expiry', async () => {
    await toolsCacheSet('staff:1', { roles: ['Director'] }, TOOLS_CACHE_TTL_MS.staffRoles);
    expect(await toolsCacheGet<{ roles: string[] }>('staff:1')).toEqual({
      roles: ['Director'],
    });
  });

  it('expires entries after maxAgeMs', async () => {
    await toolsCacheSet('staff:2', { ok: true }, 1000);
    vi.advanceTimersByTime(1001);
    expect(await toolsCacheGet('staff:2')).toBeNull();
  });

  it('withToolsCache fetches once then serves cached value', async () => {
    const fetcher = vi.fn().mockResolvedValue({ count: 3 });

    const first = await withToolsCache('key', TOOLS_CACHE_TTL_MS.userList, fetcher);
    const second = await withToolsCache('key', TOOLS_CACHE_TTL_MS.userList, fetcher);

    expect(first).toEqual({ count: 3 });
    expect(second).toEqual({ count: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
