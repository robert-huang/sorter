import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearSessionMemoForTesting,
  withSessionMemo,
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
});
