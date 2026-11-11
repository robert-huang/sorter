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

import { updateListEntry, massUpdateListEntryNotes } from '../panels/updateListEntryApi';

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

  it('reads the entry, mutates status, and reports the before and after', async () => {
    executeQueryMock
      .mockResolvedValueOnce({
        Media: {
          type: 'ANIME',
          title: { userPreferred: 'Hyouka' },
          mediaListEntry: { id: 1, notes: null, status: 'PLANNING', score: 0 },
        },
      })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { id: 1, status: 'CURRENT' },
      });

    const result = await updateListEntry({ ...BASE_FORM, status: 'CURRENT' });

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain('ListEntryForMedia');
    expect(executeQueryMock.mock.calls[1]?.[0]).toContain('SaveMediaListEntry');
    expect(executeQueryMock.mock.calls[1]?.[1]).toMatchObject({
      mediaId: 55,
      status: 'CURRENT',
    });
    expect(result.message).toContain('status');
    expect(result.changes).toEqual([
      { mediaId: 55, title: 'Hyouka', mediaType: 'ANIME', changes: ['status: PLANNING → CURRENT'] },
    ]);
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
    executeQueryMock
      .mockResolvedValueOnce({ Media: { mediaListEntry: { id: 1, notes: null } } })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { id: 1, scoreRaw: 90 },
      });

    await updateListEntry({ ...BASE_FORM, score: '90' });

    expect(dbExecMock).toHaveBeenCalled();
    expect(onDirtyIncrementMock).toHaveBeenCalled();
    expect(sessionMemoDeleteMock).toHaveBeenCalledWith('seasonal:list:testuser');
  });

  it('mass-updates notes across the list via massUpdateListEntryNotes', async () => {
    executeQueryMock
      .mockResolvedValueOnce({
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            {
              entries: [
                { notes: 'aa #airing', media: { id: 10, title: { userPreferred: 'Ten' } } },
                { notes: 'plain', media: { id: 11 } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaListCollection: {
          hasNextChunk: false,
          lists: [{ entries: [] }],
        },
      })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { id: 1, notes: 'aa #aired' },
      });

    const reported: unknown[] = [];
    const result = await massUpdateListEntryNotes(
      {
        ...BASE_FORM,
        notesFind: '#airing',
        notesReplace: '#aired',
      },
      undefined,
      (change) => reported.push(change),
    );

    expect(executeQueryMock).toHaveBeenCalledTimes(3);
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain('ListNotesCollection');
    expect(executeQueryMock.mock.calls[2]?.[1]).toMatchObject({
      mediaId: 10,
      notes: 'aa #aired',
    });
    expect(result.updatedCount).toBe(1);
    expect(result.message).toContain('Updated notes on 1 entries');
    const expected = [
      { mediaId: 10, title: 'Ten', mediaType: 'ANIME', changes: ['notes: "aa #airing" → "aa #aired"'] },
    ];
    expect(result.changes).toEqual(expected);
    expect(reported).toEqual(expected);
  });

  it('updateListEntry does not mass-update when media id is empty', async () => {
    await expect(
      updateListEntry({
        ...BASE_FORM,
        mediaId: '',
        notesFind: '#airing',
        notesReplace: '#aired',
      }),
    ).rejects.toThrow('Media ID is required');
  });
});
