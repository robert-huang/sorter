import { describe, expect, it } from 'vitest';
import { GRAPH_STALE_MS } from '../graphConstants';
import { needsGraphDataRefresh } from '../toolsFetchPolicy';

describe('needsGraphDataRefresh', () => {
  const now = Date.now();

  it('returns true when forceRefresh is set', () => {
    expect(needsGraphDataRefresh(now, { forceRefresh: true })).toBe(true);
  });

  it('returns true when fetchedAt is null', () => {
    expect(needsGraphDataRefresh(null)).toBe(true);
  });

  it('returns false when data is older than 90 days (stale is manual refresh only)', () => {
    const stale = now - GRAPH_STALE_MS - 1;
    expect(needsGraphDataRefresh(stale)).toBe(false);
  });

  it('returns false when data is fresh', () => {
    const fresh = now - GRAPH_STALE_MS + 60_000;
    expect(needsGraphDataRefresh(fresh)).toBe(false);
  });
});
