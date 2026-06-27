import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnilistAuthRequiredError } from '../../lib/importers/anilist/anilistAuth';

const executeQueryMock = vi.fn();
const requireAccessTokenMock = vi.fn();
const findAccountMock = vi.fn();
const getUserMock = vi.fn();
const dbExecMock = vi.fn();
const onDirtyIncrementMock = vi.fn();
const sessionMemoDeleteMock = vi.fn();

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
    db: { exec: dbExecMock },
    now: () => 1_700_000_000_000,
    onDirtyIncrement: onDirtyIncrementMock,
  }),
}));

vi.mock('../../lib/importers/anilist/readQueries', () => ({
  getAnilistUserByName: (...args: unknown[]) => getUserMock(...args),
}));

vi.mock('../../lib/importers/anilist/toolsSessionMemo', () => ({
  sessionMemoDelete: (...args: unknown[]) => sessionMemoDeleteMock(...args),
}));

import { updateListEntry } from '../panels/updateListEntryApi';

const BASE_FORM = {
  username: 'testuser',
  mediaId: '55',
  status: '',
  progress: '',
  progressVolumes: '',
  score: '',
  notesFind: '',
  notesReplace: '',
};

describe('updateListEntry', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    requireAccessTokenMock.mockReset();
    findAccountMock.mockReset();
    getUserMock.mockReset();
    dbExecMock.mockReset();
    onDirtyIncrementMock.mockReset();
    sessionMemoDeleteMock.mockReset();

    findAccountMock.mockReturnValue({ userId: 7, userName: 'testuser', status: 'ok' });
    requireAccessTokenMock.mockReturnValue('token');
    getUserMock.mockResolvedValue({ id: 7, name: 'testuser' });
    dbExecMock.mockResolvedValue([{ ok: 1 }]);
  });

  it('throws when not signed in', async () => {
    requireAccessTokenMock.mockImplementation(() => {
      throw new AnilistAuthRequiredError('testuser');
    });
    await expect(
      updateListEntry({ ...BASE_FORM, status: 'CURRENT' }),
    ).rejects.toThrow(AnilistAuthRequiredError);
  });

  it('mutates status without fetching notes', async () => {
    executeQueryMock.mockResolvedValueOnce({
      SaveMediaListEntry: { id: 1, status: 'CURRENT' },
    });

    const result = await updateListEntry({ ...BASE_FORM, status: 'CURRENT' });

    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain('SaveMediaListEntry');
    expect(executeQueryMock.mock.calls[0]?.[1]).toMatchObject({
      mediaId: 55,
      status: 'CURRENT',
    });
    expect(result.message).toContain('status');
  });

  it('fetches notes then skips when find not found but updates status', async () => {
    executeQueryMock
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { id: 1, notes: 'plain' } },
      })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { id: 1, status: 'PLANNING' },
      });

    const result = await updateListEntry({
      ...BASE_FORM,
      status: 'PLANNING',
      notesFind: '#airing',
      notesReplace: 'x',
    });

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('find string not found');
    expect(result.message).toContain('status');
  });

  it('patches local db after successful mutation', async () => {
    executeQueryMock.mockResolvedValueOnce({
      SaveMediaListEntry: { id: 1, scoreRaw: 90 },
    });

    await updateListEntry({ ...BASE_FORM, score: '90' });

    expect(dbExecMock).toHaveBeenCalled();
    expect(onDirtyIncrementMock).toHaveBeenCalled();
    expect(sessionMemoDeleteMock).toHaveBeenCalledWith('seasonal:list:testuser');
  });
});
