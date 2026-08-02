import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { fetchUserSeasonalShows } from '../panels/seasonalScoresApi';

vi.mock('../../lib/importers/anilist/toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/lazyExpansion', () => ({
  listedMediaNeedsSourceRepair: vi.fn(),
  repairListedMediaNullSource: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  ensureUserAnimeListFresh: vi.fn().mockResolvedValue({ id: 1, name: 'rh_test', fetched_at: 0 }),
  readUserSeasonalShowsFromDb: vi.fn().mockResolvedValue([]),
}));

import {
  listedMediaNeedsSourceRepair,
  repairListedMediaNullSource,
} from '../../lib/importers/anilist/lazyExpansion';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import { ensureUserAnimeListFresh, readUserSeasonalShowsFromDb } from '../../lib/importers/anilist/toolsAnilistAccess';

const getToolsImportContextMock = vi.mocked(getToolsImportContext);
const listedMediaNeedsSourceRepairMock = vi.mocked(listedMediaNeedsSourceRepair);
const repairListedMediaNullSourceMock = vi.mocked(repairListedMediaNullSource);
const ensureUserAnimeListFreshMock = vi.mocked(ensureUserAnimeListFresh);
const readUserSeasonalShowsFromDbMock = vi.mocked(readUserSeasonalShowsFromDb);

function seasonalShow(id: number, status = 'COMPLETED') {
  return {
    id,
    title: `Show ${id}`,
    titleSource: {
      id,
      title_english: `Show ${id}`,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    source: null,
    season: 'WINTER',
    seasonYear: 2024,
    startDate: null,
    endDate: null,
    score: 80,
    notes: null,
    listStatus: status,
  };
}

describe('fetchUserSeasonalShows', () => {
  beforeEach(() => {
    _clearSessionMemoForTesting();
    getToolsImportContextMock.mockReset();
    listedMediaNeedsSourceRepairMock.mockReset();
    repairListedMediaNullSourceMock.mockReset();
    readUserSeasonalShowsFromDbMock.mockReset();
    ensureUserAnimeListFreshMock.mockClear();
    ensureUserAnimeListFreshMock.mockResolvedValue({ id: 1, name: 'rh_test', fetched_at: 0 });
    getToolsImportContextMock.mockReturnValue({ db: { exec: vi.fn() } } as never);
    listedMediaNeedsSourceRepairMock.mockResolvedValue(false);
    repairListedMediaNullSourceMock.mockResolvedValue(0);
    readUserSeasonalShowsFromDbMock.mockResolvedValue([]);
  });

  it('memoizes the SQLite list read for 15 minutes', async () => {
    readUserSeasonalShowsFromDbMock.mockResolvedValue([seasonalShow(1)]);
    const first = await fetchUserSeasonalShows('rh_test');
    const second = await fetchUserSeasonalShows('rh_test');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledTimes(1);
    expect(readUserSeasonalShowsFromDbMock).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh busts the memo and forces the shared list import', async () => {
    readUserSeasonalShowsFromDbMock
      .mockResolvedValueOnce([seasonalShow(1)])
      .mockResolvedValueOnce([seasonalShow(2)]);

    expect((await fetchUserSeasonalShows('rh_test'))[0]?.id).toBe(1);
    expect((await fetchUserSeasonalShows('rh_test', undefined, { forceRefresh: true }))[0]?.id).toBe(2);
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledTimes(2);
    expect(ensureUserAnimeListFreshMock).toHaveBeenLastCalledWith(
      'rh_test',
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('serves PLANNING rows directly from the imported list', async () => {
    readUserSeasonalShowsFromDbMock.mockResolvedValueOnce([seasonalShow(1, 'PLANNING')]);
    const shows = await fetchUserSeasonalShows('rh_test');
    expect(shows[0]?.listStatus).toBe('PLANNING');
  });

  it('serves imported start and end dates', async () => {
    readUserSeasonalShowsFromDbMock.mockResolvedValueOnce([
      {
        ...seasonalShow(1),
        startDate: { year: 2026, month: 4, day: 1 },
        endDate: { year: 2026, month: 8, day: null },
      },
    ]);
    const shows = await fetchUserSeasonalShows('rh_test');
    expect(shows[0]?.startDate).toEqual({ year: 2026, month: 4, day: 1 });
    expect(shows[0]?.endDate).toEqual({ year: 2026, month: 8, day: null });
  });

  it('memoizes a completed empty list instead of importing it again', async () => {
    const first = await fetchUserSeasonalShows('rh_test');
    const second = await fetchUserSeasonalShows('rh_test');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledTimes(1);
    expect(readUserSeasonalShowsFromDbMock).toHaveBeenCalledTimes(1);
  });

  it('repairs listed media source before serving DB rows when source_fetched_at is missing', async () => {
    readUserSeasonalShowsFromDbMock
      .mockResolvedValueOnce([
        {
          id: 1,
          title: 'Show 1',
          titleSource: {
            id: 1,
            title_english: 'Show 1',
            title_romaji: null,
            title_native: null,
          },
          coverImage: null,
          source: null,
          season: 'WINTER',
          seasonYear: 2024,
          startDate: null,
          endDate: null,
          score: null,
          notes: null,
          listStatus: 'COMPLETED',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1,
          title: 'Show 1',
          titleSource: {
            id: 1,
            title_english: 'Show 1',
            title_romaji: null,
            title_native: null,
          },
          coverImage: null,
          source: 'WEB_NOVEL',
          season: 'WINTER',
          seasonYear: 2024,
          startDate: null,
          endDate: null,
          score: null,
          notes: null,
          listStatus: 'COMPLETED',
        },
      ]);
    listedMediaNeedsSourceRepairMock.mockResolvedValueOnce(true);

    const shows = await fetchUserSeasonalShows('rh_test');

    expect(listedMediaNeedsSourceRepairMock).toHaveBeenCalledTimes(1);
    expect(repairListedMediaNullSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      { type: 'ANIME' },
    );
    expect(shows[0]?.source).toBe('WEB_NOVEL');
  });
});
