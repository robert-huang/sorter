import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import {
  persistentCacheGet,
  persistentCacheDeletePrefix,
} from '../../lib/importers/anilist/toolsPersistentCache';
import { _resetAvailabilityCache } from '../../lib/storage';

vi.mock('../../lib/importers/anilist/depaginate', () => ({
  depaginate: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

import { depaginate } from '../../lib/importers/anilist/depaginate';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import {
  bustFranchiseListMemos,
  runFranchiseScores,
} from '../panels/franchiseScoresApi';

const depaginateMock = vi.mocked(depaginate);
const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);

function listEntry(id: number, score = 80, status = 'COMPLETED') {
  return { mediaId: id, status, score };
}

function relationsResponse(
  selfId: number,
  edges: Array<{ relationType: string; nodeId: number }> = [],
): unknown {
  return {
    Media: {
      id: selfId,
      type: 'ANIME',
      format: 'TV',
      title: { english: `Show ${selfId}`, romaji: null, native: null },
      coverImage: { large: null },
      startDate: { year: 2020, month: 1, day: 1 },
      relations: {
        edges: edges.map((e) => ({
          relationType: e.relationType,
          node: {
            id: e.nodeId,
            type: 'ANIME',
            format: 'TV',
            title: { english: `Show ${e.nodeId}`, romaji: null, native: null },
            coverImage: { large: null },
            startDate: { year: 2021, month: 4, day: 7 },
          },
        })),
      },
    },
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  window.localStorage.clear();
  _resetAvailabilityCache();
  persistentCacheDeletePrefix('franchise:');
  executeAnilistQueryMock.mockReset();
  depaginateMock.mockReset();
});

describe('runFranchiseScores caching', () => {
  it('serves the second run from cache — no extra relation fetches', async () => {
    // Seed search + relations for seed (no edges so BFS terminates immediately).
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    depaginateMock.mockResolvedValue([listEntry(100, 90)]);

    const first = await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
    });
    expect(first.entries.map((e) => e.id)).toEqual([100]);
    expect(first.entries[0]?.score).toBe(90);

    // 2 GraphQL calls (search + relations), 2 depaginate calls (anime + manga lists).
    const callsAfterFirst = executeAnilistQueryMock.mock.calls.length;
    const pageCallsAfterFirst = depaginateMock.mock.calls.length;
    expect(callsAfterFirst).toBe(2);
    expect(pageCallsAfterFirst).toBe(2);

    // Second run — everything memoized, ZERO new network calls.
    const second = await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
    });
    expect(second.entries.map((e) => e.id)).toEqual([100]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(callsAfterFirst);
    expect(depaginateMock).toHaveBeenCalledTimes(pageCallsAfterFirst);
  });

  it('forceRefresh busts relation + list memos and re-fetches', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    depaginateMock.mockResolvedValue([listEntry(100, 90)]);

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
      fetchOptions: { forceRefresh: true },
    });

    // 4 GraphQL (2 search + 2 relations), 4 depaginate (anime/manga × 2).
    expect(executeAnilistQueryMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(depaginateMock.mock.calls.length).toBe(4);
  });
});

describe('fetchUserMediaList empty-result handling', () => {
  it('does NOT memoize empty list results — next run retries', async () => {
    // Seed search + relations are constant.
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    // First run: both list fetches transiently return empty.
    depaginateMock
      .mockResolvedValueOnce([])  // anime
      .mockResolvedValueOnce([])  // manga
      // Second run: both succeed.
      .mockResolvedValueOnce([listEntry(100, 88)])
      .mockResolvedValueOnce([]);

    const first = await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    expect(first.entries[0]?.score).toBeNull();
    expect(first.entries[0]?.listStatus).toBeNull();

    const second = await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    expect(second.entries[0]?.score).toBe(88);
    // 4 depaginate calls — empty results were NOT served from cache.
    expect(depaginateMock).toHaveBeenCalledTimes(4);
  });
});

describe('franchise relations cross-session cache', () => {
  it('persists relations to localStorage so a fresh session does not re-fetch', async () => {
    executeAnilistQueryMock
      // First session: search + 2 relation calls.
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, [{ relationType: 'SEQUEL', nodeId: 200 }]))
      .mockResolvedValueOnce(relationsResponse(200, []))
      // Second "session": only the search re-fires; relations come from localStorage.
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } });
    depaginateMock.mockResolvedValue([]);

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    // Relations for both nodes landed in localStorage under the franchise prefix.
    expect(persistentCacheGet('franchise:relations:100')).toMatchObject({
      hit: true,
    });
    expect(persistentCacheGet('franchise:relations:200')).toMatchObject({
      hit: true,
    });

    // Simulate a new session: drop the in-memory session memo, but keep
    // localStorage. Relation fetches must NOT hit the network.
    _clearSessionMemoForTesting();
    const graphqlCallsBeforeSecondSession = executeAnilistQueryMock.mock.calls.length;

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    // Only the seed search (its session memo was just cleared) counts as a
    // new GraphQL call — both relation fetches come from localStorage.
    const newGraphqlCalls =
      executeAnilistQueryMock.mock.calls.length - graphqlCallsBeforeSecondSession;
    expect(newGraphqlCalls).toBe(1);
  });

  it('forceRefresh busts the persistent cache too', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    depaginateMock.mockResolvedValue([]);

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    _clearSessionMemoForTesting();
    await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
      fetchOptions: { forceRefresh: true },
    });

    // 4 calls total: search + relations × 2 runs (persistent cache busted on second).
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(4);
  });
});

describe('bustFranchiseListMemos', () => {
  it('busts anime + manga list memos but preserves the relations cache', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    depaginateMock
      .mockResolvedValueOnce([listEntry(100, 70)])
      .mockResolvedValueOnce([])
      // After bust — second list fetch (anime + manga) hits network again.
      .mockResolvedValueOnce([listEntry(100, 95)])
      .mockResolvedValueOnce([]);

    const first = await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    expect(first.entries[0]?.score).toBe(70);

    const graphqlCallsBeforeBust = executeAnilistQueryMock.mock.calls.length;
    const listCallsBeforeBust = depaginateMock.mock.calls.length;

    bustFranchiseListMemos('rh_test');

    const second = await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    expect(second.entries[0]?.score).toBe(95);

    // Relations weren't re-fetched (still cached) — no new GraphQL calls.
    expect(executeAnilistQueryMock.mock.calls.length).toBe(graphqlCallsBeforeBust);
    // Both list memos busted — 2 new depaginate calls.
    expect(depaginateMock.mock.calls.length).toBe(listCallsBeforeBust + 2);
  });
});
