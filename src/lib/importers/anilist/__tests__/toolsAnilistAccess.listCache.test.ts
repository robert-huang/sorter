import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../readQueries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../readQueries')>();
  return {
    ...actual,
    getAnilistUserByName: vi.fn(),
    getLastFullRefresh: vi.fn(),
    getLastFavouritesRefresh: vi.fn(),
  };
});

vi.mock('../runners', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runners')>();
  return {
    ...actual,
    runAnilistImport: vi.fn(),
    runAnilistFavourites: vi.fn(),
  };
});

vi.mock('../toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
}));

import {
  getAnilistUserByName,
  getLastFavouritesRefresh,
  getLastFullRefresh,
} from '../readQueries';
import { runAnilistFavourites, runAnilistImport } from '../runners';
import { getToolsImportContext } from '../toolsImportContext';
import {
  ensureUserFavouritesFresh,
  ensureUserMediaListFresh,
  readCachedFavouriteCharacterListLength,
  readUserSeasonalShowsFromDb,
} from '../toolsAnilistAccess';

const getUserMock = vi.mocked(getAnilistUserByName);
const getLastFullRefreshMock = vi.mocked(getLastFullRefresh);
const getLastFavouritesRefreshMock = vi.mocked(getLastFavouritesRefresh);
const runImportMock = vi.mocked(runAnilistImport);
const runFavouritesMock = vi.mocked(runAnilistFavourites);
const getContextMock = vi.mocked(getToolsImportContext);

const USER = {
  id: 42,
  name: 'tester',
  fetched_at: 1_700_000_000_000,
};

beforeEach(() => {
  getUserMock.mockReset();
  getLastFullRefreshMock.mockReset();
  getLastFavouritesRefreshMock.mockReset();
  runImportMock.mockReset();
  runFavouritesMock.mockReset();
  getContextMock.mockReset();
  getContextMock.mockReturnValue({ db: { exec: vi.fn().mockResolvedValue([]) } } as never);
  getUserMock.mockResolvedValue(USER);
});

describe('Tools user cache completion markers', () => {
  it('reads repeat counts for Seasonal Scores', async () => {
    const exec = vi.fn().mockResolvedValueOnce([
      {
        id: 1,
        title_english: 'Repeated Show',
        title_romaji: null,
        title_native: null,
        cover_image: null,
        season: 'WINTER',
        season_year: 2024,
        source: 'ORIGINAL',
        start_year: null,
        start_month: null,
        start_day: null,
        end_year: null,
        end_month: null,
        end_day: null,
        status: 'COMPLETED',
        score: 90,
        repeat: 2,
        notes: null,
      },
    ]);

    const shows = await readUserSeasonalShowsFromDb({ exec } as never, USER.id);

    expect(exec.mock.calls[0]?.[0]).toContain('mle.repeat');
    expect(shows[0]?.repeat).toBe(2);
  });

  it('uses only the cached character list as the rank extent', async () => {
    const exec = vi.fn().mockResolvedValueOnce([{ count: 7 }]);
    getContextMock.mockReturnValue({ db: { exec } } as never);

    await expect(
      readCachedFavouriteCharacterListLength('tester'),
    ).resolves.toBe(7);

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('FROM character_favourite'),
      [USER.id],
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(runImportMock).not.toHaveBeenCalled();
    expect(runFavouritesMock).not.toHaveBeenCalled();
  });

  it('does not re-import a valid empty media list', async () => {
    getLastFullRefreshMock.mockResolvedValue(1_700_000_000_000);

    await ensureUserMediaListFresh('tester', 'ANIME');

    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('imports a media list that has no completion marker', async () => {
    getLastFullRefreshMock.mockResolvedValue(null);

    await ensureUserMediaListFresh('tester', 'ANIME');

    expect(runImportMock).toHaveBeenCalledWith('tester', 'ANIME', undefined, undefined);
  });

  it('does not re-import a valid empty staff favourites list', async () => {
    getLastFavouritesRefreshMock.mockResolvedValue(1_700_000_000_000);

    await ensureUserFavouritesFresh('tester', 'STAFF');

    expect(runFavouritesMock).not.toHaveBeenCalled();
  });

  it('imports staff favourites that have no completion marker', async () => {
    getLastFavouritesRefreshMock.mockResolvedValue(null);

    await ensureUserFavouritesFresh('tester', 'STAFF');

    expect(runFavouritesMock).toHaveBeenCalledWith('tester', 'STAFF');
  });
});
