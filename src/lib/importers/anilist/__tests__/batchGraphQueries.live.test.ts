/**
 * Live smoke tests for batched AniList GraphQL queries (unauthenticated).
 *
 * Skipped in the default `npm test` run. Enable with:
 *   npm run test:live-anilist
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBatchedCharacterVoiceMediaQuery,
  buildBatchedMediaCharactersQuery,
  buildBatchedMediaStaffQuery,
  buildBatchedStaffFilmographyCharacterMediaQuery,
  buildBatchedStaffFilmographyStaffMediaQuery,
  buildBatchedVaCharacterMediaQuery,
  type BatchedPageRequest,
} from '../batchGraphQueries';
import { DEFAULT_DETAIL_PER_PAGE } from '../lazyExpansion';
import { DEFAULT_MEDIA_CAST_BATCH_SIZE } from '../expandMediaCastBatch';
import { MEDIA_BY_IDS_QUERY } from '../queries';
import { buildBatchedToolsMediaRelationsQuery } from '../toolsMediaRelationsApi';
import { executeAnilistQuery, _resetTransportForTesting } from '../transport';

const LIVE = process.env.ANILIST_LIVE === '1';
const describeLive = LIVE ? describe.sequential : describe.skip;

/** Stable public entities with rich graph data. */
const MEDIA_IDS = [21, 5114, 1, 5, 20] as const; // One Piece, FMA, CBB, ...
const CHARACTER_IDS = [17, 893] as const;
const STAFF_IDS = [103979, 95011] as const; // Oda, common test staff id

const PER_PAGE = DEFAULT_DETAIL_PER_PAGE;

type PagedConnection = {
  pageInfo?: { currentPage?: number; hasNextPage?: boolean };
  edges?: unknown[];
};

function pageOne(id: number): BatchedPageRequest {
  return { id, page: 1 };
}

function assertAliasHasConnection(
  data: Record<string, unknown> | null,
  alias: string,
  connectionKey: string,
): void {
  expect(data, `null response for alias ${alias}`).not.toBeNull();
  const root = data![alias];
  expect(root, `missing alias ${alias}`).toBeTruthy();
  const connection = (root as Record<string, unknown>)[connectionKey] as
    | PagedConnection
    | undefined;
  expect(connection, `${alias}.${connectionKey} missing`).toBeTruthy();
  expect(connection?.pageInfo?.currentPage).toBe(1);
  expect(Array.isArray(connection?.edges)).toBe(true);
}

async function runBatchQuery(
  label: string,
  query: string,
  variables: Record<string, unknown>,
  assert: (data: Record<string, unknown> | null) => void,
): Promise<void> {
  const data = await executeAnilistQuery<Record<string, unknown>>(query, variables);
  try {
    assert(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${message}`);
  }
}

describeLive('AniList batched GraphQL live smoke (public)', () => {
  afterEach(() => {
    _resetTransportForTesting();
  });

  it('ToolsMediaCharactersBatch accepts production batch size', async () => {
    const requests = MEDIA_IDS.slice(0, DEFAULT_MEDIA_CAST_BATCH_SIZE).map(pageOne);
    const { query, variables } = buildBatchedMediaCharactersQuery(
      requests,
      PER_PAGE,
      'JAPANESE',
    );
    await runBatchQuery('ToolsMediaCharactersBatch', query, variables, (data) => {
      for (let i = 0; i < requests.length; i += 1) {
        assertAliasHasConnection(data, `m${i}`, 'characters');
      }
    });
  });

  it('ToolsMediaStaffBatch returns staff connection per media alias', async () => {
    const requests = [pageOne(MEDIA_IDS[0]), pageOne(MEDIA_IDS[1])];
    const { query, variables } = buildBatchedMediaStaffQuery(requests, PER_PAGE);
    await runBatchQuery('ToolsMediaStaffBatch', query, variables, (data) => {
      assertAliasHasConnection(data, 'm0', 'staff');
      assertAliasHasConnection(data, 'm1', 'staff');
    });
  });

  it('ToolsCharacterVoiceMediaBatch returns character media pages', async () => {
    const requests = CHARACTER_IDS.map(pageOne);
    const { query, variables } = buildBatchedCharacterVoiceMediaQuery(requests, PER_PAGE);
    await runBatchQuery('ToolsCharacterVoiceMediaBatch', query, variables, (data) => {
      assertAliasHasConnection(data, 'c0', 'media');
      assertAliasHasConnection(data, 'c1', 'media');
    });
  });

  it('ToolsStaffFilmographyCharacterBatch returns characterMedia pages', async () => {
    const requests = STAFF_IDS.map(pageOne);
    const { query, variables } = buildBatchedStaffFilmographyCharacterMediaQuery(
      requests,
      PER_PAGE,
    );
    await runBatchQuery('ToolsStaffFilmographyCharacterBatch', query, variables, (data) => {
      assertAliasHasConnection(data, 's0', 'characterMedia');
      assertAliasHasConnection(data, 's1', 'characterMedia');
      expect((data!.s0 as { id?: number }).id).toBe(STAFF_IDS[0]);
    });
  });

  it('ToolsStaffFilmographyStaffMediaBatch returns staffMedia pages', async () => {
    const requests = STAFF_IDS.map(pageOne);
    const { query, variables } = buildBatchedStaffFilmographyStaffMediaQuery(
      requests,
      PER_PAGE,
    );
    await runBatchQuery('ToolsStaffFilmographyStaffMediaBatch', query, variables, (data) => {
      assertAliasHasConnection(data, 's0', 'staffMedia');
      assertAliasHasConnection(data, 's1', 'staffMedia');
    });
  });

  it('ToolsVaCharacterMediaBatch returns slim characterMedia pages', async () => {
    const requests = [pageOne(STAFF_IDS[0])];
    const { query, variables } = buildBatchedVaCharacterMediaQuery(requests, PER_PAGE);
    await runBatchQuery('ToolsVaCharacterMediaBatch', query, variables, (data) => {
      assertAliasHasConnection(data, 's0', 'characterMedia');
    });
  });

  it('MediaByIds id_in batch returns listed media', async () => {
    await runBatchQuery(
      'MediaByIds',
      MEDIA_BY_IDS_QUERY,
      { mediaIds: [MEDIA_IDS[0], MEDIA_IDS[1]], page: 1, perPage: 50 },
      (data) => {
        const page = data?.Page as { media?: Array<{ id?: number }> } | undefined;
        expect(page?.media?.length).toBeGreaterThanOrEqual(2);
        const ids = new Set(page?.media?.map((m) => m.id));
        expect(ids.has(MEDIA_IDS[0])).toBe(true);
        expect(ids.has(MEDIA_IDS[1])).toBe(true);
      },
    );
  });

  it('ToolsMediaRelationsV2Batch returns relations per media alias', async () => {
    const { query, variables } = buildBatchedToolsMediaRelationsQuery([
      MEDIA_IDS[0],
      MEDIA_IDS[1],
    ]);
    await runBatchQuery('ToolsMediaRelationsV2Batch', query, variables, (data) => {
      const m0 = data?.m0 as { id?: number; relations?: { edges?: unknown[] } } | undefined;
      expect(m0?.id).toBe(MEDIA_IDS[0]);
      expect(Array.isArray(m0?.relations?.edges)).toBe(true);
      const m1 = data?.m1 as { id?: number; relations?: { edges?: unknown[] } } | undefined;
      expect(m1?.id).toBe(MEDIA_IDS[1]);
      expect(Array.isArray(m1?.relations?.edges)).toBe(true);
    });
  });
});
