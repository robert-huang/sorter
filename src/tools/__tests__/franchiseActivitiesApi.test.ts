import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import {
  fetchFranchiseActivities,
  FRANCHISE_ACTIVITIES_QUERY,
} from '../panels/franchiseActivitiesApi';
import { FRANCHISE_ACTIVITIES_CACHE_TTL_MS } from '../panels/franchiseActivitiesCache';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);

function activityPayload(
  id: number,
  mediaId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    __typename: 'ListActivity',
    id,
    status: 'watched episode',
    progress: String(id),
    createdAt: 1_700_000_000 + id,
    siteUrl: `https://anilist.co/activity/${id}`,
    replyCount: 0,
    media: {
      id: mediaId,
      type: 'ANIME',
      siteUrl: `https://anilist.co/anime/${mediaId}`,
      title: { english: `Show ${mediaId}`, romaji: null, native: null },
    },
    ...overrides,
  };
}

function activityPage(
  activities: unknown[],
  hasNextPage = false,
  currentPage = 1,
) {
  return {
    Page: {
      pageInfo: { hasNextPage, currentPage },
      activities,
    },
  };
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _clearSessionMemoForTesting();
  executeAnilistQueryMock.mockReset();
  await _resetDisposableCacheDbForTesting();
});

describe('fetchFranchiseActivities', () => {
  it('resolves the user, batches media ids, paginates, and deduplicates ids', async () => {
    executeAnilistQueryMock.mockImplementation(async (query, variables) => {
      if (query.includes('ResolveUser')) {
        return { User: { id: 42, name: 'ActivityUser' } } as never;
      }
      if (variables?.page === 1) {
        return activityPage([activityPayload(1, 100)], true, 1) as never;
      }
      return activityPage(
        [activityPayload(1, 100), activityPayload(2, 200)],
        false,
        2,
      ) as never;
    });

    const rows = await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [200, 100, 200],
    });

    expect(rows.map((row) => row.id).sort()).toEqual([1, 2]);
    expect(FRANCHISE_ACTIVITIES_QUERY).toContain('mediaId_in: $mediaIds');
    const activityCalls = executeAnilistQueryMock.mock.calls.filter(([query]) =>
      query.includes('FranchiseActivities'),
    );
    expect(activityCalls).toHaveLength(2);
    expect(activityCalls[0]?.[1]).toMatchObject({
      userId: 42,
      mediaIds: [100, 200],
      page: 1,
      perPage: 50,
    });
  });

  it('reuses per-media IndexedDB entries without touching the API', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ User: { id: 42, name: 'ActivityUser' } } as never)
      .mockResolvedValueOnce(
        activityPage([activityPayload(1, 100), activityPayload(2, 200)]) as never,
      );
    await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100, 200],
    });

    executeAnilistQueryMock.mockClear();
    const rows = await fetchFranchiseActivities({
      username: 'activityuser',
      mediaIds: [200],
    });

    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(executeAnilistQueryMock).not.toHaveBeenCalled();
  });

  it('fetches only media missing from the per-media cache', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ User: { id: 42, name: 'ActivityUser' } } as never)
      .mockResolvedValueOnce(
        activityPage([activityPayload(1, 100)]) as never,
      );
    await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100],
    });

    executeAnilistQueryMock.mockClear();
    executeAnilistQueryMock.mockResolvedValueOnce(
      activityPage([activityPayload(2, 200)]) as never,
    );
    const rows = await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100, 200],
    });

    expect(rows.map((row) => row.id).sort()).toEqual([1, 2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(1);
    expect(executeAnilistQueryMock.mock.calls[0]?.[1]).toMatchObject({
      mediaIds: [200],
    });
  });

  it('expires cached media after the fifteen-minute TTL', async () => {
    let now = Date.parse('2026-08-09T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    executeAnilistQueryMock
      .mockResolvedValueOnce({ User: { id: 42, name: 'ActivityUser' } } as never)
      .mockResolvedValueOnce(
        activityPage([activityPayload(1, 100)]) as never,
      );
    await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100],
    });

    now += FRANCHISE_ACTIVITIES_CACHE_TTL_MS + 1;
    executeAnilistQueryMock.mockClear();
    executeAnilistQueryMock.mockResolvedValueOnce(
      activityPage([activityPayload(2, 100)]) as never,
    );
    const rows = await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100],
    });

    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(1);
  });

  it('force refreshes selected media even while their cache is fresh', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ User: { id: 42, name: 'ActivityUser' } } as never)
      .mockResolvedValueOnce(
        activityPage([activityPayload(1, 100)]) as never,
      );
    await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100],
    });

    executeAnilistQueryMock.mockClear();
    executeAnilistQueryMock.mockResolvedValueOnce(
      activityPage([activityPayload(2, 100)]) as never,
    );
    const rows = await fetchFranchiseActivities({
      username: 'ActivityUser',
      mediaIds: [100],
      forceRefresh: true,
    });

    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown username before requesting activities', async () => {
    executeAnilistQueryMock.mockResolvedValueOnce({ User: null } as never);
    await expect(
      fetchFranchiseActivities({
        username: 'missing-user',
        mediaIds: [100],
      }),
    ).rejects.toThrow("AniList has no user named 'missing-user'");
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(1);
  });

  it('honours an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchFranchiseActivities({
        username: 'ActivityUser',
        mediaIds: [100],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeAnilistQueryMock).not.toHaveBeenCalled();
  });

  it('ignores malformed union nodes instead of crashing', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ User: { id: 42, name: 'ActivityUser' } } as never)
      .mockResolvedValueOnce(
        activityPage([
          { __typename: 'TextActivity', id: 1 },
          { __typename: 'ListActivity', id: 'bad' },
        ]) as never,
      );
    await expect(
      fetchFranchiseActivities({
        username: 'ActivityUser',
        mediaIds: [100],
      }),
    ).resolves.toEqual([]);
  });
});
