import { describe, expect, it } from 'vitest';
import {
  formatGraphCacheDate,
  graphStaleRefreshTooltip,
  isGraphTimestampStale,
  oldestStaleGraphTimestamp,
} from '../graphConstants';

describe('graphConstants', () => {
  it('formatGraphCacheDate renders YYYY-MM-DD in local time', () => {
    // 2024-06-15 noon UTC — date may shift by timezone; pin a local-noon instant.
    const local = new Date(2024, 5, 15, 12, 0, 0);
    expect(formatGraphCacheDate(local.getTime())).toBe('2024-06-15');
  });

  it('graphStaleRefreshTooltip includes the cache date', () => {
    const fetchedAt = new Date(2024, 0, 2, 12, 0, 0).getTime();
    expect(
      graphStaleRefreshTooltip(fetchedAt, "This entry's cached cast", 'refresh'),
    ).toBe(
      "This entry's cached cast is over 90 days old (2024-01-02) — click to refresh from AniList",
    );
  });

  it('oldestStaleGraphTimestamp picks the oldest stale timestamp', () => {
    const now = Date.now();
    const staleA = now - 100 * 24 * 60 * 60 * 1000;
    const staleB = now - 120 * 24 * 60 * 60 * 1000;
    const fresh = now - 1 * 24 * 60 * 60 * 1000;
    expect(
      oldestStaleGraphTimestamp([staleA, staleB, fresh, null], now),
    ).toBe(staleB);
    expect(isGraphTimestampStale(staleB, now)).toBe(true);
  });
});
