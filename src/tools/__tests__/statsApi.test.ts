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
  expandStatsCast,
  fetchStatsData,
  refreshStatsCastFromDb,
} from '../panels/statsApi';
import {
  ensureMediaCastFreshBatch,
  ensureMediaStudiosFreshBatch,
  readShowStaffBundleFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';

const depaginateMock = vi.mocked(depaginate);
const getCtxMock = vi.mocked(getToolsImportContext);
const getMediaDetailMock = vi.mocked(getMediaDetail);
const ensureCastMock = vi.mocked(ensureMediaCastFreshBatch);
const ensureStudiosMock = vi.mocked(ensureMediaStudiosFreshBatch);
const readStaffBundleMock = vi.mocked(readShowStaffBundleFromDb);

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
  ensureCastMock.mockReset();
  ensureStudiosMock.mockReset();
  readStaffBundleMock.mockReset();

  getCtxMock.mockReturnValue({ db: {} } as never);
  getMediaDetailMock.mockResolvedValue(null);
  ensureCastMock.mockResolvedValue();
  ensureStudiosMock.mockResolvedValue();
  readStaffBundleMock.mockResolvedValue(null);
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

  it('checkpoints reusable media data after every fetched list page', async () => {
    const progress = vi.fn();
    depaginateMock.mockImplementationOnce(async (options) => {
      const nodes = [gqlListEntry(101), gqlListEntry(102)];
      await options.onPage?.({
        page: 1,
        nodes,
        pageInfo: { hasNextPage: false },
        collected: nodes.length,
      });
      return nodes;
    });

    await fetchStatsData('tester', 'ANIME', { onProgress: progress });

    expect(ensureStudiosMock).toHaveBeenCalledWith(
      [101, 102],
      expect.objectContaining({ onProgress: progress }),
    );
    expect(progress).toHaveBeenCalledWith({
      phase: 'list',
      index: 1,
      total: 1,
    });
  });

  it('preserves persisted staff and VA genders from the cached staff bundle', async () => {
    readStaffBundleMock.mockResolvedValue({
      id: 101,
      title: 'Show 101',
      coverImage: null,
      studios: {},
      productionStaff: {
        7: {
          name: 'Director',
          image: null,
          gender: 'Female',
          roles: ['Director'],
        },
      },
      voiceActors: {
        8: {
          name: 'Voice Actor',
          image: null,
          gender: 'Male',
          roles: ['MAIN Hero'],
          roleCharacterIds: [9],
        },
      },
    });

    const data = await fetchStatsData('tester', 'ANIME');
    const expanded = await expandStatsCast(data);

    expect(expanded.entries[0]?.staffCredits[0]?.staffGender).toBe('Female');
    expect(expanded.entries[0]?.vaCredits[0]?.staffGender).toBe('Male');
  });

  it('re-reads cast from the database without triggering AniList expansion', async () => {
    readStaffBundleMock.mockResolvedValue({
      id: 101,
      title: 'Show 101',
      coverImage: null,
      studios: {},
      productionStaff: {
        7: {
          name: 'Updated Director',
          image: null,
          gender: 'Female',
          roles: ['Director'],
        },
      },
      voiceActors: {},
    });
    const data = await fetchStatsData('tester', 'ANIME');

    const refreshed = await refreshStatsCastFromDb({
      ...data,
      castExpanded: true,
    });

    expect(ensureCastMock).not.toHaveBeenCalled();
    expect(refreshed.entries[0]?.staffCredits[0]?.staffName).toBe(
      'Updated Director',
    );
  });

  it('reports durable cast checkpoints without resetting progress during DB reads', async () => {
    const progress = vi.fn();
    ensureCastMock.mockImplementationOnce(async (_mediaIds, _options, onCheckpoint) => {
      onCheckpoint?.({ completed: 1, total: 1 });
    });
    readStaffBundleMock.mockResolvedValue({
      id: 101,
      title: 'Show 101',
      coverImage: null,
      studios: {},
      productionStaff: {},
      voiceActors: {},
    });
    const data = await fetchStatsData('tester', 'ANIME');

    await expandStatsCast(data, { onProgress: progress });

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({
      phase: 'cast',
      index: 1,
      total: 1,
    });
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
