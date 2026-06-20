import { describe, expect, it } from 'vitest';
import {
  formatGraphCacheDate,
  graphStaleRefreshTooltip,
  hasKnownGraphCacheDate,
  isGraphTimestampStale,
  isUnknownGraphCacheDate,
  oldestStaleGraphTimestamp,
} from '../graphConstants';

describe('graphConstants', () => {
  it('isUnknownGraphCacheDate detects v1 backfill sentinel', () => {
    expect(isUnknownGraphCacheDate(0)).toBe(true);
    expect(isUnknownGraphCacheDate(-1)).toBe(true);
    expect(isUnknownGraphCacheDate(1_700_000_000_000)).toBe(false);
  });

  it('isGraphTimestampStale treats unknown cache dates as stale', () => {
    expect(isGraphTimestampStale(0)).toBe(true);
    expect(isGraphTimestampStale(null)).toBe(false);
  });

  it('hasKnownGraphCacheDate rejects v1 backfill sentinels', () => {
    expect(hasKnownGraphCacheDate(null)).toBe(false);
    expect(hasKnownGraphCacheDate(0)).toBe(false);
    expect(hasKnownGraphCacheDate(1_700_000_000_000)).toBe(true);
  });

  it('formatGraphCacheDate renders YYYY-MM-DD in local time', () => {
    // 2024-06-15 noon UTC — date may shift by timezone; pin a local-noon instant.
    const local = new Date(2024, 5, 15, 12, 0, 0);
    expect(formatGraphCacheDate(local.getTime())).toBe('2024-06-15');
  });

  it('formatGraphCacheDate avoids epoch for unknown cache dates', () => {
    expect(formatGraphCacheDate(0)).toBe('unknown date');
  });

  it('graphStaleRefreshTooltip includes the cache date', () => {
    const fetchedAt = new Date(2024, 0, 2, 12, 0, 0).getTime();
    expect(
      graphStaleRefreshTooltip(fetchedAt, "This entry's cached cast", 'refresh'),
    ).toBe(
      "This entry's cached cast is over 90 days old (2024-01-02) — click to refresh from AniList",
    );
  });

  it('graphStaleRefreshTooltip uses unknown date for backfilled rows', () => {
    expect(
      graphStaleRefreshTooltip(0, "This entry's cached cast", 'refresh'),
    ).toBe(
      "This entry's cached cast is over 90 days old (unknown date) — click to refresh from AniList",
    );
  });

  it('oldestStaleGraphTimestamp prefers known stale dates over unknown', () => {
    const now = Date.now();
    const stale = now - 100 * 24 * 60 * 60 * 1000;
    expect(oldestStaleGraphTimestamp([0, stale], now)).toBe(stale);
    expect(oldestStaleGraphTimestamp([0], now)).toBe(0);
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
