import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearSessionMemoForTesting,
  withSessionMemo,
  withSessionTtlMemo,
} from '../toolsSessionMemo';

describe('toolsSessionMemo', () => {
  beforeEach(() => {
    _clearSessionMemoForTesting();
  });

  it('withSessionMemo fetches once then serves memoized value', async () => {
    const fetcher = vi.fn().mockResolvedValue({ count: 3 });

    const first = await withSessionMemo('key', fetcher);
    const second = await withSessionMemo('key', fetcher);

    expect(first).toEqual({ count: 3 });
    expect(second).toEqual({ count: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh bypasses memo', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await withSessionMemo('key', fetcher)).toBe(1);
    expect(await withSessionMemo('key', fetcher, { forceRefresh: true })).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('withSessionTtlMemo fetches once within TTL', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ count: 3 });

    const first = await withSessionTtlMemo('ttl-key', 60_000, fetcher);
    const second = await withSessionTtlMemo('ttl-key', 60_000, fetcher);

    expect(first).toEqual({ count: 3 });
    expect(second).toEqual({ count: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('withSessionTtlMemo re-fetches after TTL expires', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await withSessionTtlMemo('ttl-key', 60_000, fetcher)).toBe(1);
    vi.advanceTimersByTime(60_001);
    expect(await withSessionTtlMemo('ttl-key', 60_000, fetcher)).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('withSessionTtlMemo bust clears cached value', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await withSessionTtlMemo('ttl-key', 60_000, fetcher)).toBe(1);
    expect(await withSessionTtlMemo('ttl-key', 60_000, fetcher, { bust: true })).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
