/**
 * fetchRelatedAnimeIds caching contract:
 *
 *   - Walks the AniList relations graph starting from `rootMediaId`,
 *     stopping at OTHER edges / MUSIC nodes / Crossover-tagged nodes
 *     (matches Shared Staff "ignore related" semantics).
 *   - The walked set is persisted across sessions in localStorage for
 *     90 days — relations rarely change after release. The BFS walk
 *     batches up to 15 media per GraphQL call per depth level (same
 *     pattern as Franchise Trace / Adaptation Scores).
 *   - Force-refresh busts BOTH the session memo and the persistent
 *     cache so the next call walks from scratch (right-click Compare).
 *   - Cross-session reload is simulated by clearing the session memo
 *     while leaving localStorage intact — the persistent cache must
 *     survive and serve the value without re-walking.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { persistentCacheDeletePrefix } from '../../lib/importers/anilist/toolsPersistentCache';
import { _resetAvailabilityCache } from '../../lib/storage';

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { fetchRelatedAnimeIds } from '../panels/sharedStaffApi';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);

type RelationEdge = {
  relationType: string;
  node: {
    id: number;
    type: string;
    format?: string | null;
    tags?: Array<{ name: string }> | null;
  };
};


/** Batch GraphQL shape used by `fetchRelationsWalkBatch`. */
function batchWalkRelationsResponse(
  entries: Array<{ edges: RelationEdge[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    out[`m${index}`] = { relations: { edges: entry.edges } };
  });
  return out;
}

function anime(id: number, opts: Partial<RelationEdge['node']> = {}): RelationEdge['node'] {
  return { id, type: 'ANIME', format: 'TV', tags: [], ...opts };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  window.localStorage.clear();
  _resetAvailabilityCache();
  persistentCacheDeletePrefix('shared-staff:');
  executeAnilistQueryMock.mockReset();
});

describe('fetchRelatedAnimeIds caching', () => {
  it('walks once and serves the second call from the in-session memo', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce(
        batchWalkRelationsResponse([
          { edges: [{ relationType: 'SEQUEL', node: anime(2) }] },
        ]),
      )
      .mockResolvedValueOnce(batchWalkRelationsResponse([{ edges: [] }]));

    const first = await fetchRelatedAnimeIds(1);
    expect([...first].sort((a, b) => a - b)).toEqual([2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);

    // Second call within the session: session memo serves it, no live
    // calls. (No need to drop into the persistent layer.)
    const second = await fetchRelatedAnimeIds(1);
    expect([...second]).toEqual([2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);
  });

  it('persists across simulated session reloads via localStorage', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce(
        batchWalkRelationsResponse([
          { edges: [{ relationType: 'SEQUEL', node: anime(2) }] },
        ]),
      )
      .mockResolvedValueOnce(batchWalkRelationsResponse([{ edges: [] }]));

    await fetchRelatedAnimeIds(1);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);

    // Simulate a new session: in-memory memo is cleared, localStorage
    // survives. The persistent cache must serve the prior walk.
    _clearSessionMemoForTesting();

    const afterReload = await fetchRelatedAnimeIds(1);
    expect([...afterReload]).toEqual([2]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh busts both memo layers and re-walks', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce(
        batchWalkRelationsResponse([
          { edges: [{ relationType: 'SEQUEL', node: anime(2) }] },
        ]),
      )
      .mockResolvedValueOnce(batchWalkRelationsResponse([{ edges: [] }]));

    await fetchRelatedAnimeIds(1);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);

    // Refresh now also picks up a brand-new prequel that AniList added.
    // Nodes 2 and 3 are siblings at the same depth — one batched call.
    executeAnilistQueryMock
      .mockResolvedValueOnce(
        batchWalkRelationsResponse([
          {
            edges: [
              { relationType: 'SEQUEL', node: anime(2) },
              { relationType: 'PREQUEL', node: anime(3) },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(
        batchWalkRelationsResponse([{ edges: [] }, { edges: [] }]),
      );

    const refreshed = await fetchRelatedAnimeIds(1, undefined, { forceRefresh: true });
    expect([...refreshed].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(4);
  });

  it('stops walking at OTHER edges, MUSIC nodes, and Crossover-tagged nodes', async () => {
    // Root has 4 children: a normal sequel (walked), an OTHER edge
    // (added to set but not enqueued), a MUSIC sibling (added but
    // not walked), and a Crossover side-story (added but not walked).
    executeAnilistQueryMock.mockResolvedValueOnce(
      batchWalkRelationsResponse([
        {
          edges: [
            { relationType: 'SEQUEL', node: anime(2) },
            { relationType: 'OTHER', node: anime(3) },
            { relationType: 'SIDE_STORY', node: anime(4, { format: 'MUSIC' }) },
            {
              relationType: 'SIDE_STORY',
              node: anime(5, { tags: [{ name: 'Crossover' }] }),
            },
            // Manga node: ignored entirely (different media type).
            { relationType: 'ADAPTATION', node: { id: 6, type: 'MANGA' } },
          ],
        },
      ]),
    );
    // Only node 2 (the SEQUEL) should get a follow-up walk.
    executeAnilistQueryMock.mockResolvedValueOnce(
      batchWalkRelationsResponse([{ edges: [] }]),
    );

    const related = await fetchRelatedAnimeIds(1);
    expect([...related].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    // 2 calls: root + node 2. Nodes 3/4/5 were added to the set but
    // their relations weren't fetched. Node 6 was skipped entirely.
    expect(executeAnilistQueryMock).toHaveBeenCalledTimes(2);
  });
});
