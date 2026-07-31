import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';

vi.mock('../../lib/importers/anilist/depaginate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/depaginate')>();
  return {
    ...actual,
    depaginate: vi.fn(),
  };
});

vi.mock('../../lib/importers/anilist/anilistAuth', () => ({
  resolveAccessTokenForUsername: vi.fn(() => null),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/toolsImportContext')>();
  return {
    ...actual,
    getToolsImportContext: vi.fn(),
  };
});

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/toolsAnilistAccess')>();
  return {
    ...actual,
    ensureMediaCastFreshBatch: vi.fn(),
    ensureMediaStudiosFreshBatch: vi.fn(),
    readShowStaffBundleFromDb: vi.fn(),
  };
});

vi.mock('../../lib/importers/anilist/readQueries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/readQueries')>();
  return {
    ...actual,
    getMediaDetail: vi.fn(),
    getMediaCastExpansionStatus: vi.fn(),
  };
});

import { depaginate } from '../../lib/importers/anilist/depaginate';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import { getMediaDetail } from '../../lib/importers/anilist/readQueries';
import {
  bustStatsSessionMemo,
  fetchStatsData,
} from '../panels/statsApi';

const depaginateMock = vi.mocked(depaginate);
const getCtxMock = vi.mocked(getToolsImportContext);
const getMediaDetailMock = vi.mocked(getMediaDetail);

function gqlListEntry(mediaId: number) {
  return {
    status: 'COMPLETED',
    score: 80,
    progress: 12,
    progressVolumes: null,
    repeat: null,
    notes: null,
    media: {
      id: mediaId,
      title: { english: `Show ${mediaId}`, romaji: null, native: null },
      coverImage: { large: null },
      format: 'TV',
      status: 'FINISHED',
      episodes: 12,
      chapters: null,
      volumes: null,
      duration: 24,
      meanScore: 75,
    },
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  depaginateMock.mockReset();
  getCtxMock.mockReset();
  getMediaDetailMock.mockReset();

  getCtxMock.mockReturnValue({ db: {} } as never);
  getMediaDetailMock.mockResolvedValue(null);
  depaginateMock.mockResolvedValue([gqlListEntry(101)]);
});

describe('fetchStatsData', () => {
  it('memoizes list fetch per username and media type', async () => {
    await fetchStatsData('tester', 'ANIME');
    await fetchStatsData('tester', 'ANIME');

    expect(depaginateMock).toHaveBeenCalledTimes(1);
  });

  it('busts memo when forceRefresh is set', async () => {
    await fetchStatsData('tester', 'ANIME');
    await fetchStatsData('tester', 'ANIME', { forceRefresh: true });

    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });

  it('aborts before memoized work when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchStatsData('tester', 'ANIME', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(depaginateMock).not.toHaveBeenCalled();
  });

  it('passes abort signal through to list depaginate', async () => {
    const controller = new AbortController();
    await fetchStatsData('tester', 'ANIME', { signal: controller.signal });

    expect(depaginateMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('bustStatsSessionMemo', () => {
  it('forces the next fetch to reload the list', async () => {
    await fetchStatsData('tester', 'MANGA');
    bustStatsSessionMemo('tester', 'MANGA');
    await fetchStatsData('tester', 'MANGA');

    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });
});
