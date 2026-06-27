import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { fetchUserSeasonalShows } from '../panels/seasonalScoresApi';

vi.mock('../../lib/importers/anilist/depaginate', () => ({
  depaginate: vi.fn(),
}));

// Mirror the production constant so the assertion below catches accidental
// regressions of "PLANNING is now optional again". If this changes, the
// "Include Planning" checkbox can no longer be an instant client-side filter.
vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  TOOLS_SEASONAL_LIST_STATUSES: ['COMPLETED', 'CURRENT', 'REPEATING', 'PAUSED', 'PLANNING'],
  ensureUserAnimeListFresh: vi.fn().mockResolvedValue({ id: 1 }),
  readUserSeasonalShowsFromDb: vi.fn().mockResolvedValue([]),
}));

import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  ensureUserAnimeListFresh,
  readUserSeasonalShowsFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';

const depaginateMock = vi.mocked(depaginate);
const ensureUserAnimeListFreshMock = vi.mocked(ensureUserAnimeListFresh);

function listEntry(id: number, status = 'COMPLETED') {
  return {
    status,
    score: 80,
    notes: null,
    media: {
      id,
      title: { english: `Show ${id}`, romaji: null },
      coverImage: null,
      season: 'WINTER',
      seasonYear: 2024,
    },
  };
}

describe('fetchUserSeasonalShows', () => {
  beforeEach(() => {
    _clearSessionMemoForTesting();
    depaginateMock.mockReset();
    ensureUserAnimeListFreshMock.mockClear();
    depaginateMock.mockResolvedValue([listEntry(1)]);
  });

  it('memoizes the live list fetch for 15 minutes', async () => {
    const first = await fetchUserSeasonalShows('rh_test');
    const second = await fetchUserSeasonalShows('rh_test');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(depaginateMock).toHaveBeenCalledTimes(1);
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes AniList score 0 to null', async () => {
    depaginateMock.mockResolvedValueOnce([{ ...listEntry(1), score: 0 }]);
    const shows = await fetchUserSeasonalShows('rh_test');
    expect(shows[0]?.score).toBeNull();
  });

  it('forceRefresh busts the memo and re-fetches', async () => {
    depaginateMock.mockResolvedValueOnce([listEntry(1)]).mockResolvedValueOnce([listEntry(2)]);

    expect((await fetchUserSeasonalShows('rh_test'))[0]?.id).toBe(1);
    expect((await fetchUserSeasonalShows('rh_test', undefined, { forceRefresh: true }))[0]?.id).toBe(2);
    expect(depaginateMock).toHaveBeenCalledTimes(2);
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledTimes(2);
  });

  it('always requests PLANNING in statusIn so the checkbox is a client-side filter', async () => {
    await fetchUserSeasonalShows('rh_test');
    expect(depaginateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({
          statusIn: expect.arrayContaining(['PLANNING']),
        }),
      }),
    );
  });

  it('maps PLANNING list status from API entries into the SeasonalShow', async () => {
    depaginateMock.mockResolvedValueOnce([listEntry(1, 'PLANNING')]);
    const shows = await fetchUserSeasonalShows('rh_test');
    expect(shows[0]?.listStatus).toBe('PLANNING');
  });

  it('maps startDate and endDate from API media into SeasonalShow', async () => {
    depaginateMock.mockResolvedValueOnce([
      {
        ...listEntry(1),
        media: {
          ...listEntry(1).media,
          startDate: { year: 2026, month: 4, day: 1 },
          endDate: { year: 2026, month: 8, day: null },
        },
      },
    ]);
    const shows = await fetchUserSeasonalShows('rh_test');
    expect(shows[0]?.startDate).toEqual({ year: 2026, month: 4, day: 1 });
    expect(shows[0]?.endDate).toEqual({ year: 2026, month: 8, day: null });
  });

  it('shares the same cache regardless of whether the consumer wants planning shown', async () => {
    // No more per-(user, planning) cache split — both reads serve the
    // same PLANNING-inclusive list from one network round trip.
    await fetchUserSeasonalShows('rh_test');
    await fetchUserSeasonalShows('rh_test');
    expect(depaginateMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize empty results — retries on the next call', async () => {
    // First call: AniList short-circuits (rate-limit, `data: null`) → [].
    // Second call should NOT hit the cache; otherwise the user is stuck
    // with an empty/2026-only chart until the 15m TTL expires.
    depaginateMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([listEntry(1)]);

    const first = await fetchUserSeasonalShows('rh_test');
    const second = await fetchUserSeasonalShows('rh_test');

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });
});
