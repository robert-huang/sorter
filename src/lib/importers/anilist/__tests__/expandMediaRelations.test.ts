import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { expandMediaRelations } from '../expandMediaRelations';
import type { AnilistMediaRelationsResponse } from '../types';
import {
  makeTestAnilistImportContext,
  openTestAnilistDb,
  seedMediaRow,
  TEST_ANILIST_NOW,
} from './testAnilistDb';

const SEED_ID = 100;
const NEIGHBOR_ID = 200;

function makeRelationsResponse(
  edges: Array<{ relationType: string; nodeId: number }> = [],
): AnilistMediaRelationsResponse {
  return {
    Media: {
      id: SEED_ID,
      title: { english: `Seed ${SEED_ID}`, romaji: null, native: null },
      type: 'ANIME',
      relations: {
        edges: edges.map((edge) => ({
          relationType: edge.relationType,
          node: {
            id: edge.nodeId,
            type: 'ANIME',
            format: 'TV',
            title: { english: `Show ${edge.nodeId}`, romaji: null, native: null },
            coverImage: { large: null },
            startDate: { year: 2020, month: 1, day: 1 },
          } as never,
        })),
      },
    },
  } as AnilistMediaRelationsResponse;
}

describe('expandMediaRelations', () => {
  let db: Database;

  beforeEach(async () => {
    _clearDbSyncManifestForTesting();
    db = await openTestAnilistDb();
    seedMediaRow(db, SEED_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes edges, neighbor media, and a freshness marker', async () => {
    const ctx = makeTestAnilistImportContext(db);
    const result = await expandMediaRelations(ctx, SEED_ID, {
      response: makeRelationsResponse([{ relationType: 'SEQUEL', nodeId: NEIGHBOR_ID }]),
    });

    expect(result).toEqual({
      fromMediaId: SEED_ID,
      relationsWritten: 1,
      mediaUpserted: 2,
    });

    const edges = db.selectObjects(
      'SELECT to_media_id, relation_type FROM media_relation WHERE from_media_id = ?',
      [SEED_ID],
    );
    expect(edges).toEqual([{ to_media_id: NEIGHBOR_ID, relation_type: 'SEQUEL' }]);

    const marker = db.selectObject(
      'SELECT fetched_at FROM media_relations_expansion WHERE media_id = ?',
      [SEED_ID],
    );
    expect(marker?.fetched_at).toBe(TEST_ANILIST_NOW);
  });

  it('force deletes existing outbound edges before inserting fresh ones', async () => {
    seedMediaRow(db, NEIGHBOR_ID);
    seedMediaRow(db, 201);
    db.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?), (?, ?, ?)`,
      { bind: [SEED_ID, NEIGHBOR_ID, 'SEQUEL', SEED_ID, 201, 'PREQUEL'] },
    );

    const ctx = makeTestAnilistImportContext(db);
    await expandMediaRelations(ctx, SEED_ID, {
      force: true,
      response: makeRelationsResponse([{ relationType: 'SIDE_STORY', nodeId: NEIGHBOR_ID }]),
    });

    const edges = db.selectObjects(
      'SELECT to_media_id, relation_type FROM media_relation WHERE from_media_id = ? ORDER BY to_media_id',
      [SEED_ID],
    );
    expect(edges).toEqual([{ to_media_id: NEIGHBOR_ID, relation_type: 'SIDE_STORY' }]);
  });

  it('writes a marker even when the response has zero edges', async () => {
    const ctx = makeTestAnilistImportContext(db);
    await expandMediaRelations(ctx, SEED_ID, {
      response: makeRelationsResponse([]),
    });

    const marker = db.selectObject(
      'SELECT fetched_at FROM media_relations_expansion WHERE media_id = ?',
      [SEED_ID],
    );
    expect(marker?.fetched_at).toBe(TEST_ANILIST_NOW);
    expect(
      db.selectObjects('SELECT 1 FROM media_relation WHERE from_media_id = ?', [SEED_ID]),
    ).toEqual([]);
  });
});
