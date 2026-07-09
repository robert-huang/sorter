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
import {
  buildBatchedAdaptationRelationsQuery,
  linksFromRelationScan,
  runAdaptationScores,
  type AdaptationRelationsResponse,
} from '../panels/adaptationScoresApi';
import type { ToolsMediaRelationsResponse } from '../../lib/importers/anilist/toolsMediaRelationsApi';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);
const getCtxMock = vi.mocked(getToolsImportContext);
const ensureUserMediaListFreshMock = vi.mocked(ensureUserMediaListFresh);
const readUserMediaListEntriesFromDbMock = vi.mocked(readUserMediaListEntriesFromDb);

function relationsResponse(
  selfId: number,
  edges: Array<{ relationType: string; nodeId: number; nodeType?: 'ANIME' | 'MANGA' }> = [],
  selfType: 'ANIME' | 'MANGA' = 'ANIME',
): unknown {
  return {
    Media: {
      id: selfId,
      type: selfType,
      format: selfType === 'MANGA' ? 'MANGA' : 'TV',
      title: { english: `Show ${selfId}`, romaji: null, native: null },
      coverImage: { large: null },
      startDate: { year: 2020, month: 1, day: 1 },
      relations: {
        edges: edges.map((edge) => ({
          relationType: edge.relationType,
          node: {
            id: edge.nodeId,
            type: edge.nodeType ?? 'MANGA',
            format: edge.nodeType === 'MANGA' ? 'MANGA' : 'TV',
            title: { english: `Media ${edge.nodeId}`, romaji: null, native: null },
            coverImage: { large: null },
            startDate: { year: 2019, month: 1, day: 1 },
          },
        })),
      },
    },
  };
}

let sqliteDb: Database;

beforeEach(async () => {
  _clearSessionMemoForTesting();
  executeAnilistQueryMock.mockReset();
  ensureUserMediaListFreshMock.mockReset();
  readUserMediaListEntriesFromDbMock.mockReset();
  sqliteDb = await openTestAnilistDb();
  getCtxMock.mockReturnValue(
    makeTestAnilistImportContext(sqliteDb, { now: () => Date.now() }),
  );
  ensureUserMediaListFreshMock.mockResolvedValue({
    id: 1,
    name: 'tester',
    fetched_at: Date.now(),
  } as never);
});

describe('buildBatchedAdaptationRelationsQuery', () => {
  it('builds aliased Media fields for each id', () => {
    const { query, variables } = buildBatchedAdaptationRelationsQuery([10, 20]);
    expect(query).toContain('m0: Media(id: $id0)');
    expect(query).toContain('m1: Media(id: $id1)');
    expect(query).toContain('relationType(version: 2)');
    expect(variables).toEqual({ id0: 10, id1: 20 });
  });
});

function relationsMedia(
  selfId: number,
  edges: Array<{ relationType: string; nodeId: number; nodeType?: 'ANIME' | 'MANGA' }> = [],
  selfType: 'ANIME' | 'MANGA' = 'ANIME',
) {
  const payload = relationsResponse(selfId, edges, selfType) as {
    Media: ToolsMediaRelationsResponse['media'];
  };
  return payload.Media;
}

describe('linksFromRelationScan', () => {
  it('normalizes v2 SOURCE/ADAPTATION edges from list items', () => {
    const responses = new Map<number, AdaptationRelationsResponse>([
      [
        10,
        {
          media: relationsMedia(10, [{ relationType: 'SOURCE', nodeId: 5 }]),
          edges: [{ relationType: 'SOURCE', node: relationsMedia(5) }],
        },
      ],
      [
        20,
        {
          media: relationsMedia(20, [{ relationType: 'ADAPTATION', nodeId: 30 }]),
          edges: [{ relationType: 'ADAPTATION', node: relationsMedia(30, [], 'MANGA') }],
        },
      ],
    ]);

    expect(linksFromRelationScan([10, 20], responses)).toEqual([
      { sourceId: 5, adaptationId: 10, seedId: 10 },
      { sourceId: 20, adaptationId: 30, seedId: 20 },
    ]);
  });

  it('orients bidirectional ADAPTATION to manga|anime after both sides are scanned', () => {
    const responses = new Map<number, AdaptationRelationsResponse>([
      [
        107068,
        {
          media: relationsMedia(107068, [], 'ANIME'),
          edges: [
            {
              relationType: 'ADAPTATION',
              node: relationsMedia(85533, [], 'MANGA'),
            },
            {
              relationType: 'ADAPTATION',
              node: relationsMedia(87142, [], 'MANGA'),
            },
          ],
        },
      ],
      [
        87142,
        {
          media: relationsMedia(87142, [], 'MANGA'),
          edges: [
            {
              relationType: 'ADAPTATION',
              node: relationsMedia(107068, [], 'ANIME'),
            },
          ],
        },
      ],
      [
        85533,
        {
          media: relationsMedia(85533, [], 'MANGA'),
          edges: [
            {
              relationType: 'ADAPTATION',
              node: relationsMedia(107068, [], 'ANIME'),
            },
          ],
        },
      ],
    ]);

    expect(linksFromRelationScan([107068, 87142, 85533], responses)).toEqual(
      expect.arrayContaining([
        { sourceId: 85533, adaptationId: 107068, seedId: 107068 },
        { sourceId: 85533, adaptationId: 107068, seedId: 85533 },
        { sourceId: 87142, adaptationId: 107068, seedId: 107068 },
        { sourceId: 87142, adaptationId: 107068, seedId: 87142 },
      ]),
    );
  });
});

describe('runAdaptationScores', () => {
  it('returns table display and scan data from list relation fetch', async () => {
    readUserMediaListEntriesFromDbMock.mockImplementation(async (_db, _userId, type) => {
      if (type === 'ANIME') {
        return [
          {
            mediaId: 10,
            status: 'COMPLETED',
            score: 85,
            startedYear: 2021,
            startedMonth: 1,
            startedDay: 1,
          },
        ];
      }
      return [];
    });

    executeAnilistQueryMock.mockImplementation(async (_query, variables) => {
      const mediaId = (variables as { id0?: number }).id0 ?? (variables as { mediaId?: number }).mediaId;
      if (mediaId === 10) {
        const payload = relationsResponse(10, [
          { relationType: 'SOURCE', nodeId: 5, nodeType: 'MANGA' },
        ]) as { Media: ToolsMediaRelationsResponse['media'] };
        return { m0: payload.Media };
      }
      return null;
    });

    const output = await runAdaptationScores({
      username: 'tester',
      filters: {
        includeAnime: true,
        includeManga: true,
        listStatuses: ['CURRENT', 'COMPLETED', 'REPEATING'],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
    });

    expect(output.scan.links).toEqual([{ sourceId: 5, adaptationId: 10, seedId: 10 }]);
    expect(output.display.kind).toBe('table');
    if (output.display.kind === 'table') {
      expect(output.display.blocks.length).toBeGreaterThan(0);
    }
  });

  it('returns empty when no list entries are available', async () => {
    readUserMediaListEntriesFromDbMock.mockResolvedValue([]);

    const output = await runAdaptationScores({
      username: 'tester',
      filters: {
        includeAnime: true,
        includeManga: false,
        listStatuses: ['CURRENT', 'COMPLETED', 'REPEATING'],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
    });

    expect(output.display).toEqual({
      kind: 'empty',
      message: 'No list entries to scan for adaptations.',
    });
    expect(output.scan.links).toEqual([]);
  });
});
