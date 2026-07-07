import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnilistAuthRequiredError } from '../../lib/importers/anilist/anilistAuth';

const executeQueryMock = vi.fn();
const requireAccessTokenMock = vi.fn();
const findAccountMock = vi.fn();
const getUserMock = vi.fn();
const getFavouritesMock = vi.fn();
const runFavouritesMock = vi.fn();
const dbExecMock = vi.fn();
const dbTransactionMock = vi.fn();
const onDirtyIncrementMock = vi.fn();

vi.mock('../../lib/importers/anilist/anilistAuth', () => ({
  findAnilistAccountByName: (...args: unknown[]) => findAccountMock(...args),
  requireAccessTokenForUsername: (...args: unknown[]) =>
    requireAccessTokenMock(...args),
  AnilistAuthRequiredError: class AnilistAuthRequiredError extends Error {
    constructor(userName: string) {
      super(`auth required: ${userName}`);
      this.name = 'AnilistAuthRequiredError';
    }
  },
}));

vi.mock('../../lib/importers/anilist/context', () => ({
  makeAnilistImportContext: () => ({
    executeQuery: executeQueryMock,
  }),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', () => ({
  getToolsImportContext: () => ({
    db: {
      exec: dbExecMock,
      execBatch: dbTransactionMock,
    },
    now: () => 1_700_000_000_000,
    onDirtyIncrement: onDirtyIncrementMock,
  }),
}));

vi.mock('../../lib/importers/anilist/readQueries', () => ({
  getAnilistUserByName: (...args: unknown[]) => getUserMock(...args),
  getFavouritesAsItems: (...args: unknown[]) => getFavouritesMock(...args),
}));

vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistFavourites: (...args: unknown[]) => runFavouritesMock(...args),
}));

import {
  loadFavouritesFresh,
  saveFavouriteOrder,
  unfavouriteItems,
} from '../panels/reorderFavouritesApi';

const FORM = {
  username: 'testuser',
  favouriteType: 'CHARACTERS' as const,
};

describe('reorderFavouritesApi', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    requireAccessTokenMock.mockReset();
    findAccountMock.mockReset();
    getUserMock.mockReset();
    getFavouritesMock.mockReset();
    runFavouritesMock.mockReset();
    dbExecMock.mockReset();
    dbTransactionMock.mockReset();
    onDirtyIncrementMock.mockReset();

    findAccountMock.mockReturnValue({ userId: 7, userName: 'testuser', status: 'ok' });
    requireAccessTokenMock.mockReturnValue('token');
    getUserMock.mockResolvedValue({ id: 7, name: 'testuser' });
    runFavouritesMock.mockResolvedValue({ count: 2 });
    getFavouritesMock.mockResolvedValue([
      { externalId: 1, label: 'Alpha', imageUrl: null },
      { externalId: 2, label: 'Beta', imageUrl: null },
    ]);
    dbTransactionMock.mockResolvedValue(undefined);
    dbExecMock.mockResolvedValue([]);
  });

  it('loadFavouritesFresh always imports then reads cache', async () => {
    const result = await loadFavouritesFresh(FORM);

    expect(runFavouritesMock).toHaveBeenCalledWith('testuser', 'CHARACTERS', undefined);
    expect(getFavouritesMock).toHaveBeenCalled();
    expect(result.anilistUserId).toBe(7);
    expect(result.items.map((item) => item.label)).toEqual(['Alpha', 'Beta']);
  });

  it('saveFavouriteOrder mutates then patches cache sort_order', async () => {
    executeQueryMock.mockResolvedValueOnce({
      UpdateFavouriteOrder: { anime: { pageInfo: { total: 2 } } },
    });

    await saveFavouriteOrder(
      FORM,
      7,
      [
        { id: 2, label: 'Beta', imageUrl: null, sortOrder: 0 },
        { id: 1, label: 'Alpha', imageUrl: null, sortOrder: 1 },
      ],
    );

    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain('pageInfo');
    expect(executeQueryMock.mock.calls[0]?.[1]).toEqual({
      characterIds: [2, 1],
      characterOrder: [1, 2],
    });
    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
    expect(onDirtyIncrementMock).toHaveBeenCalled();
  });

  it('saveFavouriteOrder requires auth', async () => {
    requireAccessTokenMock.mockImplementation(() => {
      throw new AnilistAuthRequiredError('testuser');
    });
    await expect(
      saveFavouriteOrder(FORM, 7, [
        { id: 1, label: 'Alpha', imageUrl: null, sortOrder: 0 },
      ]),
    ).rejects.toThrow(AnilistAuthRequiredError);
  });

  it('unfavouriteItems toggles each id and deletes cache rows', async () => {
    executeQueryMock
      .mockResolvedValueOnce({ ToggleFavourite: { __typename: 'Favourite' } })
      .mockResolvedValueOnce({ ToggleFavourite: { __typename: 'Favourite' } });

    await unfavouriteItems(FORM, 7, [1, 2]);

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(dbExecMock).toHaveBeenCalledTimes(1);
    expect(String(dbExecMock.mock.calls[0]?.[0])).toContain('DELETE FROM character_favourite');
    expect(onDirtyIncrementMock).toHaveBeenCalled();
  });
});
