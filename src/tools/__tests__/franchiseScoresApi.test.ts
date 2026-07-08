/**
 * Franchise Scores caching contract:
 *
 *   - The user's anime + manga lists are read from the source DB via
 *     `ensureUserMediaListFresh` + `readUserMediaListEntriesFromDb`.
 *     They are NOT live-fetched on every Trace — that was the original
 *     cache gap. The username refresh button flows
 *     `forceRefresh: true` through ensureUserMediaListFresh to re-
 *     import.
 *   - Relations are walked through `executeAnilistQuery` and the per-
 *     node response is persisted to localStorage for 90 days. The
 *     walker is wrapped in a session memo + persistent cache so the
 *     second Trace within a session does ZERO network calls, and a
 *     reload still serves the prior walk from localStorage.
 *   - Right-click Trace (forceRefresh) busts BOTH the relation
 *     persistent cache AND triggers a fresh AniList list import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import {
  persistentCacheGet,
  persistentCacheDeletePrefix,
} from '../../lib/importers/anilist/toolsPersistentCache';
import { TOOLS_MEDIA_RELATIONS_CACHE_PREFIX } from '../../lib/importers/anilist/toolsMediaRelationsApi';
import { _resetAvailabilityCache } from '../../lib/storage';

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  ensureUserMediaListFresh: vi.fn(),
  readUserMediaListEntriesFromDb: vi.fn(),
}));

import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  ensureUserMediaListFresh,
  readUserMediaListEntriesFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { runFranchiseScores } from '../panels/franchiseScoresApi';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);
const getCtxMock = vi.mocked(getToolsImportContext);
const ensureUserMediaListFreshMock = vi.mocked(ensureUserMediaListFresh);
const readUserMediaListEntriesFromDbMock = vi.mocked(readUserMediaListEntriesFromDb);

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

function dbEntry(
  mediaId: number,
  score: number | null,
  status: string | null = 'COMPLETED',
) {
  return {
    mediaId,
    status,
    score,
    startedYear: null,
    startedMonth: null,
    startedDay: null,
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  window.localStorage.clear();
  _resetAvailabilityCache();
  persistentCacheDeletePrefix(TOOLS_MEDIA_RELATIONS_CACHE_PREFIX);
  persistentCacheDeletePrefix('franchise:');
  executeAnilistQueryMock.mockReset();
  getCtxMock.mockReset();
  ensureUserMediaListFreshMock.mockReset();
  readUserMediaListEntriesFromDbMock.mockReset();

  getCtxMock.mockReturnValue({ db: { exec: vi.fn() } } as never);
  // Default: user exists in DB and ensureUserMediaListFresh is a no-op
  // (the DB is already fresh). Override per-test to simulate force-
  // refresh / first-import flows.
  ensureUserMediaListFreshMock.mockResolvedValue({
    id: 42,
    name: 'rh_test',
    fetched_at: Date.now(),
  } as never);
  readUserMediaListEntriesFromDbMock.mockResolvedValue([]);
});

describe('runFranchiseScores caching', () => {
  it('serves both list types from the DB and does zero list-related GraphQL calls', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    readUserMediaListEntriesFromDbMock.mockImplementation(async (_db, _uid, type) =>
      type === 'ANIME' ? [dbEntry(100, 90)] : [],
    );

    const first = await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
    });
    expect(first.entries.map((e) => e.id)).toEqual([100]);
    expect(first.entries[0]?.score).toBe(90);

    // Both list types ensured + read; only 2 GraphQL calls (search + relations).
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledTimes(2);
    expect(readUserMediaListEntriesFromDbMock).toHaveBeenCalledTimes(2);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);

    // Second run: relations cached in session memo, list still served
    // from DB. Search re-fires in this test (search has its own
    // separate session memo, but per call site it's keyed by the
    // exact search string so a repeat of "Seed" is also memoized —
    // ZERO new GraphQL calls expected).
    const callsBeforeSecond = executeAnilistQueryMock.mock.calls.length;
    const second = await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
    });
    expect(second.entries.map((e) => e.id)).toEqual([100]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(callsBeforeSecond);
    // ensureUserMediaListFresh is idempotent + cheap — calling it
    // again is fine (and intentional so the username refresh button
    // doesn't need to bust per-tool memos).
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledTimes(4);
  });

  it('forceRefresh threads through to ensureUserMediaListFresh for BOTH list types', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    readUserMediaListEntriesFromDbMock.mockResolvedValue([dbEntry(100, 88)]);

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
      fetchOptions: { forceRefresh: true },
    });

    // First run: ANIME + MANGA, no force. Second run: ANIME + MANGA, force.
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledWith('rh_test', 'ANIME', undefined);
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledWith('rh_test', 'MANGA', undefined);
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledWith(
      'rh_test',
      'ANIME',
      { forceRefresh: true },
    );
    expect(ensureUserMediaListFreshMock).toHaveBeenCalledWith(
      'rh_test',
      'MANGA',
      { forceRefresh: true },
    );
  });

  it('returns score=null when the user has the show on their list but unrated', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    // AniList POINT_100 stores "not rated" as 0; the DB read returns 0
    // verbatim and the franchise layer normalizes it to null so the
    // chart renders "—" instead of "0".
    readUserMediaListEntriesFromDbMock.mockImplementation(async (_db, _uid, type) =>
      type === 'ANIME' ? [dbEntry(100, 0, 'CURRENT')] : [],
    );

    const result = await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    expect(result.entries[0]?.score).toBeNull();
    expect(result.entries[0]?.listStatus).toBe('CURRENT');
  });

  it('handles a missing user gracefully (ensureUserMediaListFresh returns null)', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));
    // Both type lookups return null → readUserMediaListEntriesFromDb
    // is skipped entirely; the franchise entry shows up with no list
    // info instead of crashing on the missing user id.
    ensureUserMediaListFreshMock.mockResolvedValue(null);

    const result = await runFranchiseScores({ seedSearch: 'Seed', username: 'nobody' });
    expect(result.entries[0]?.score).toBeNull();
    expect(result.entries[0]?.listStatus).toBeNull();
    expect(readUserMediaListEntriesFromDbMock).not.toHaveBeenCalled();
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

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    expect(persistentCacheGet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}100`)).toMatchObject({ hit: true });
    expect(persistentCacheGet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}200`)).toMatchObject({ hit: true });

    _clearSessionMemoForTesting();
    const callsBeforeSecondSession = executeAnilistQueryMock.mock.calls.length;

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    // Only the seed search re-fires; both relation walks come from localStorage.
    const newCalls = executeAnilistQueryMock.mock.calls.length - callsBeforeSecondSession;
    expect(newCalls).toBe(1);
  });

  it('forceRefresh busts the persistent relations cache', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(relationsResponse(100, []));

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    _clearSessionMemoForTesting();
    await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
      fetchOptions: { forceRefresh: true },
    });

    // 4 calls: search + relations × 2 runs (persistent cache busted on second).
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(4);
  });
});
