import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveDownloadFilename } from '../storage';

describe('saveDownloadFilename', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts the sanitized slot name before the timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 21, 5));
    expect(saveDownloadFilename('Winter 2026: OPs/EDs')).toBe(
      'sorter-Winter 2026_ OPs_EDs-20261030-2105.json',
    );
    expect(saveDownloadFilename('  ')).toBe('sorter-20261030-2105.json');
    expect(saveDownloadFilename()).toBe('sorter-20261030-2105.json');
  });
});
