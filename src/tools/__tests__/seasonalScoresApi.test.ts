import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { fetchUserSeasonalShows } from '../panels/seasonalScoresApi';

vi.mock('../../lib/importers/anilist/depaginate', () => ({
  depaginate: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  TOOLS_SEASONAL_LIST_STATUSES: ['COMPLETED', 'CURRENT', 'REPEATING', 'PAUSED'],
  ensureUserAnimeListFresh: vi.fn().mockResolvedValue({ id: 1 }),
}));

import { depaginate } from '../../lib/importers/anilist/depaginate';
import { ensureUserAnimeListFresh } from '../../lib/importers/anilist/toolsAnilistAccess';

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

  it('includes PLANNING in statusIn when includePlanning is set', async () => {
    await fetchUserSeasonalShows('rh_test', undefined, { includePlanning: true });
    expect(depaginateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({
          statusIn: expect.arrayContaining(['PLANNING']),
        }),
      }),
    );
  });

  it('maps list status from API entries', async () => {
    depaginateMock.mockResolvedValueOnce([listEntry(1, 'PLANNING')]);
    const shows = await fetchUserSeasonalShows('rh_test', undefined, { includePlanning: true });
    expect(shows[0]?.listStatus).toBe('PLANNING');
  });

  it('uses separate memo keys for planning vs base fetches', async () => {
    await fetchUserSeasonalShows('rh_test');
    await fetchUserSeasonalShows('rh_test', undefined, { includePlanning: true });
    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });
});
