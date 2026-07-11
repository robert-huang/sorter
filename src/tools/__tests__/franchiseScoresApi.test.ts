/**
 * Franchise Scores caching contract:
 *
 *   - The user's anime + manga lists are read from the source DB via
 *     `ensureUserMediaListFresh` + `readUserMediaListEntriesFromDb`.
 *   - Relations are walked through `fetchToolsMediaRelationsBatch`,
 *     which persists edges in SQLite (`media_relation` +
 *     `media_relations_expansion`) and only hits AniList when the
 *     marker is missing or stale (>90d). BFS fetches one depth level
 *     per batch (up to 15 media per GraphQL call). Session memo dedupes
 *     within a tab; SQLite survives reloads and Drive sync.
 *   - Right-click Trace (forceRefresh) busts the SQLite marker and
 *     triggers a fresh AniList list import.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import {
  makeTestAnilistImportContext,
  openTestAnilistDb,
} from '../../lib/importers/anilist/__tests__/testAnilistDb';

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

let sqliteDb: Database;

function wireToolsDb(db: Database): void {
  getCtxMock.mockReturnValue(
    makeTestAnilistImportContext(db, { now: () => Date.now() }),
  );
}

function relationsMediaPayload(
  selfId: number,
  edges: Array<{ relationType: string; nodeId: number }> = [],
): unknown {
  return {
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
  };
}

/** Batch GraphQL shape returned by `fetchToolsMediaRelationsBatch`. */
function batchRelationsResponse(
  entries: Array<{
    selfId: number;
    edges?: Array<{ relationType: string; nodeId: number }>;
  }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    out[`m${index}`] = relationsMediaPayload(
      entry.selfId,
      entry.edges ?? [],
    );
  });
  return out;
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

beforeEach(async () => {
  _clearSessionMemoForTesting();
  executeAnilistQueryMock.mockReset();
  getCtxMock.mockReset();
  ensureUserMediaListFreshMock.mockReset();
  readUserMediaListEntriesFromDbMock.mockReset();

  sqliteDb = await openTestAnilistDb();
  wireToolsDb(sqliteDb);
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
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]));
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
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]));
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
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]));
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
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]));
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
  it('persists relations to SQLite so a fresh session does not re-fetch', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(
        batchRelationsResponse([
          { selfId: 100, edges: [{ relationType: 'SEQUEL', nodeId: 200 }] },
        ]),
      )
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 200 }]))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } });

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    expect(
      sqliteDb.selectObject(
        'SELECT 1 AS ok FROM media_relations_expansion WHERE media_id = 100',
      ),
    ).toEqual({ ok: 1 });

    _clearSessionMemoForTesting();
    const callsBeforeSecondSession = executeAnilistQueryMock.mock.calls.length;

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });

    const newCalls = executeAnilistQueryMock.mock.calls.length - callsBeforeSecondSession;
    expect(newCalls).toBe(1);
  });

  it('forceRefresh re-fetches relation edges from AniList', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]))
      .mockResolvedValueOnce({ Media: { id: 100, title: { english: 'Seed', romaji: null } } })
      .mockResolvedValueOnce(batchRelationsResponse([{ selfId: 100 }]));

    await runFranchiseScores({ seedSearch: 'Seed', username: 'rh_test' });
    _clearSessionMemoForTesting();
    await runFranchiseScores({
      seedSearch: 'Seed',
      username: 'rh_test',
      fetchOptions: { forceRefresh: true },
    });

    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(4);
  });
});
