import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../toolsSessionMemo';
import {
  persistentCacheDeletePrefix,
  persistentCacheGet,
  persistentCacheSet,
} from '../toolsPersistentCache';
import {
  TOOLS_MEDIA_RELATIONS_CACHE_PREFIX,
  _resetToolsRelationsBackfillForTesting,
  fetchToolsMediaRelationsBatch,
  fetchToolsMediaRelationsCached,
  type ToolsMediaRelationsResponse,
} from '../toolsMediaRelationsApi';
import {
  makeTestAnilistImportContext,
  openTestAnilistDb,
  seedMediaRow,
} from './testAnilistDb';

vi.mock('../transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

vi.mock('../toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
  _resetToolsImportContextForTesting: vi.fn(),
}));

import { executeAnilistQuery } from '../transport';
import { getToolsImportContext } from '../toolsImportContext';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);
const getCtxMock = vi.mocked(getToolsImportContext);

function livePayload(
  mediaId: number,
  edges: Array<{ relationType: string; nodeId: number }> = [],
): unknown {
  return {
    Media: {
      id: mediaId,
      type: 'ANIME',
      format: 'TV',
      title: { english: `Show ${mediaId}`, romaji: null, native: null },
      coverImage: { large: null },
      startDate: { year: 2020, month: 1, day: 1 },
      relations: {
        edges: edges.map((edge) => ({
          relationType: edge.relationType,
          node: {
            id: edge.nodeId,
            type: 'ANIME',
            format: 'TV',
            title: { english: `Show ${edge.nodeId}`, romaji: null, native: null },
            coverImage: { large: null },
            startDate: { year: 2021, month: 4, day: 7 },
          },
        })),
      },
    },
  };
}

function wireDb(db: Database): void {
  getCtxMock.mockReturnValue(
    makeTestAnilistImportContext(db, { now: () => Date.now() }),
  );
}

beforeEach(async () => {
  _clearSessionMemoForTesting();
  _resetToolsRelationsBackfillForTesting();
  persistentCacheDeletePrefix('franchise:relations:');
  persistentCacheDeletePrefix('adaptation:relations:');
  persistentCacheDeletePrefix(TOOLS_MEDIA_RELATIONS_CACHE_PREFIX);
  executeAnilistQueryMock.mockReset();
  window.localStorage.clear();
});

describe('fetchToolsMediaRelationsCached', () => {
  it('prunes legacy per-tool relation cache keys on first fetch', async () => {
    const db = await openTestAnilistDb();
    wireDb(db);
    persistentCacheSet('franchise:relations:10', { media: { id: 10 }, edges: [] }, 60_000);
    persistentCacheSet('adaptation:relations:20', { media: { id: 20 }, edges: [] }, 60_000);

    executeAnilistQueryMock.mockResolvedValue(livePayload(99));

    await fetchToolsMediaRelationsCached(99);

    expect(persistentCacheGet('franchise:relations:10')).toEqual({ hit: false });
    expect(persistentCacheGet('adaptation:relations:20')).toEqual({ hit: false });
    expect(persistentCacheGet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}99`)).toEqual({ hit: false });
  });

  it('reads fresh relations from SQLite without calling AniList', async () => {
    const db = await openTestAnilistDb();
    seedMediaRow(db, 50);
    seedMediaRow(db, 51);
    db.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?)`,
      { bind: [50, 51, 'SEQUEL'] },
    );
    db.exec(
      `INSERT INTO media_relations_expansion (media_id, fetched_at) VALUES (?, ?)`,
      { bind: [50, Date.now()] },
    );
    wireDb(db);

    const result = await fetchToolsMediaRelationsCached(50);

    expect(executeAnilistQueryMock).not.toHaveBeenCalled();
    expect(result?.media.id).toBe(50);
    expect(result?.edges).toEqual([
      expect.objectContaining({
        relationType: 'SEQUEL',
        node: expect.objectContaining({ id: 51 }),
      }),
    ]);
  });

  it('persists live relations to SQLite and serves them on the next call', async () => {
    const db = await openTestAnilistDb();
    wireDb(db);
    executeAnilistQueryMock.mockResolvedValue(
      livePayload(77, [{ relationType: 'ADAPTATION', nodeId: 88 }]),
    );

    const first = await fetchToolsMediaRelationsCached(77);
    expect(first?.edges[0]?.node.id).toBe(88);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(1);

    _clearSessionMemoForTesting();
    executeAnilistQueryMock.mockClear();

    const second = await fetchToolsMediaRelationsCached(77);
    expect(second?.edges[0]?.node.id).toBe(88);
    expect(executeAnilistQueryMock).not.toHaveBeenCalled();
  });

  it('backfills legacy localStorage entries into SQLite once per session', async () => {
    const db = await openTestAnilistDb();
    wireDb(db);

    const cached: ToolsMediaRelationsResponse = {
      media: {
        id: 42,
        type: 'ANIME',
        format: 'TV',
        title: { english: 'Legacy', romaji: null, native: null },
        coverImage: { large: null },
        startDate: { year: 2019, month: 1, day: 1 },
      },
      edges: [
        {
          relationType: 'SOURCE',
          node: {
            id: 43,
            type: 'MANGA',
            format: 'MANGA',
            title: { english: 'Legacy source', romaji: null, native: null },
            coverImage: { large: null },
            startDate: { year: 2018, month: 1, day: 1 },
          },
        },
      ],
    };
    persistentCacheSet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}42`, cached, 60_000);

    const result = await fetchToolsMediaRelationsCached(42);

    expect(executeAnilistQueryMock).not.toHaveBeenCalled();
    expect(result?.edges[0]?.relationType).toBe('SOURCE');
    expect(
      db.selectObject('SELECT 1 AS ok FROM media_relations_expansion WHERE media_id = 42'),
    ).toEqual({ ok: 1 });
    expect(persistentCacheGet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}42`)).toEqual({ hit: false });
  });
});

describe('fetchToolsMediaRelationsBatch', () => {
  it('resumes after a failed group without refetching completed relation markers', async () => {
    const db = await openTestAnilistDb();
    wireDb(db);
    executeAnilistQueryMock
      .mockResolvedValueOnce({
        m0: (livePayload(1) as { Media: unknown }).Media,
        m1: (livePayload(2) as { Media: unknown }).Media,
      })
      .mockRejectedValueOnce(new Error('batch failed'))
      .mockResolvedValueOnce(livePayload(3))
      .mockRejectedValueOnce(new Error('item 4 failed'));

    await expect(
      fetchToolsMediaRelationsBatch([1, 2, 3, 4], { batchSize: 2 }),
    ).rejects.toThrow('item 4 failed');

    expect(
      db.selectValue('SELECT COUNT(*) FROM media_relations_expansion'),
    ).toBe(3);

    executeAnilistQueryMock.mockResolvedValueOnce({
      m0: (livePayload(4) as { Media: unknown }).Media,
    });
    const resumed = await fetchToolsMediaRelationsBatch([1, 2, 3, 4], {
      batchSize: 2,
    });

    expect(resumed.size).toBe(4);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(5);
    expect(executeAnilistQueryMock.mock.calls[4]?.[1]).toEqual({ id0: 4 });
  });
});
