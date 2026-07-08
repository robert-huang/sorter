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

  it('replaces existing outbound edges on a plain refresh (drops removed relations)', async () => {
    seedMediaRow(db, NEIGHBOR_ID);
    seedMediaRow(db, 201);
    db.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?), (?, ?, ?)`,
      { bind: [SEED_ID, NEIGHBOR_ID, 'SEQUEL', SEED_ID, 201, 'PREQUEL'] },
    );

    const ctx = makeTestAnilistImportContext(db);
    await expandMediaRelations(ctx, SEED_ID, {
      response: makeRelationsResponse([{ relationType: 'SIDE_STORY', nodeId: NEIGHBOR_ID }]),
    });

    const edges = db.selectObjects(
      'SELECT to_media_id, relation_type FROM media_relation WHERE from_media_id = ? ORDER BY to_media_id',
      [SEED_ID],
    );
    expect(edges).toEqual([{ to_media_id: NEIGHBOR_ID, relation_type: 'SIDE_STORY' }]);
  });

  it('normalizes relation type casing on write', async () => {
    const ctx = makeTestAnilistImportContext(db);
    await expandMediaRelations(ctx, SEED_ID, {
      response: makeRelationsResponse([{ relationType: 'sequel', nodeId: NEIGHBOR_ID }]),
    });

    const edges = db.selectObjects(
      'SELECT relation_type FROM media_relation WHERE from_media_id = ?',
      [SEED_ID],
    );
    expect(edges).toEqual([{ relation_type: 'SEQUEL' }]);
  });

  it('writes chart fields without clobbering list-owned media metadata', async () => {
    // A rich, list-imported neighbor row that also shows up as a relation.
    db.exec(
      `INSERT INTO media (id, type, title_english, source, mean_score, fetched_at, updated_at)
         VALUES (?, 'ANIME', ?, 'ORIGINAL', 77, ?, ?)`,
      { bind: [NEIGHBOR_ID, 'Rich Title', TEST_ANILIST_NOW, TEST_ANILIST_NOW] },
    );

    const ctx = makeTestAnilistImportContext(db);
    await expandMediaRelations(ctx, SEED_ID, {
      response: makeRelationsResponse([{ relationType: 'SEQUEL', nodeId: NEIGHBOR_ID }]),
    });

    const row = db.selectObject(
      'SELECT source, mean_score, start_year, title_english FROM media WHERE id = ?',
      [NEIGHBOR_ID],
    );
    // List-owned fields survive; chart fields (start date) get filled in.
    expect(row?.source).toBe('ORIGINAL');
    expect(row?.mean_score).toBe(77);
    expect(row?.start_year).toBe(2020);
    expect(row?.title_english).toBe('Show 200');
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
