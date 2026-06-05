import { describe, expect, it, vi } from 'vitest';
import {
  OPFS_INIT_BASE_DELAY_MS,
  OPFS_INIT_MAX_ATTEMPTS,
  opfsInitBackoffMs,
  withOpfsInstallRetry,
} from '../opfsInstallRetry';

describe('opfsInstallRetry', () => {
  it('computes linear backoff from attempt number', () => {
    expect(opfsInitBackoffMs(1)).toBe(OPFS_INIT_BASE_DELAY_MS);
    expect(opfsInitBackoffMs(3)).toBe(OPFS_INIT_BASE_DELAY_MS * 3);
  });

  it('returns true on first successful attempt without sleeping', async () => {
    const sleepFn = vi.fn(async () => undefined);
    const tryOnce = vi.fn(async () => true);

    const ok = await withOpfsInstallRetry(tryOnce, sleepFn);

    expect(ok).toBe(true);
    expect(tryOnce).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries until success then stops', async () => {
    const sleepFn = vi.fn(async () => undefined);
    let calls = 0;
    const tryOnce = vi.fn(async () => {
      calls += 1;
      return calls >= 3;
    });

    const ok = await withOpfsInstallRetry(tryOnce, sleepFn);

    expect(ok).toBe(true);
    expect(tryOnce).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, opfsInitBackoffMs(1));
    expect(sleepFn).toHaveBeenNthCalledWith(2, opfsInitBackoffMs(2));
  });

  it('returns false after max attempts', async () => {
    const sleepFn = vi.fn(async () => undefined);
    const tryOnce = vi.fn(async () => false);

    const ok = await withOpfsInstallRetry(tryOnce, sleepFn);

    expect(ok).toBe(false);
    expect(tryOnce).toHaveBeenCalledTimes(OPFS_INIT_MAX_ATTEMPTS);
    expect(sleepFn).toHaveBeenCalledTimes(OPFS_INIT_MAX_ATTEMPTS - 1);
  });
});
