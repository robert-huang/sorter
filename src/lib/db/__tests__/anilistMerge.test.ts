import { describe, expect, it } from 'vitest';
import type { Database } from '@sqlite.org/sqlite-wasm';
import '../../importers/anilist/anilistSource';
import {
  anilistSourceDescriptor,
  ensureAnilistSourceRegistered,
} from '../../importers/anilist/anilistSource';
import {
  openTestAnilistDb,
  seedMediaRow,
  TEST_ANILIST_NOW,
} from '../../importers/anilist/__tests__/testAnilistDb';
import { openDbFromBytes, serializeDb } from '../dbBytes';
import { pullMerge } from '../merge';
import { getTestSqlite } from './testSqlite';

function exportAndClose(
  sqlite3: Awaited<ReturnType<typeof getTestSqlite>>,
  db: Database,
): Uint8Array {
  const bytes = serializeDb(sqlite3, db);
  db.close();
  return bytes;
}

describe('pullMerge — anilist media relations', () => {
  it('unions disjoint relation edges from local and remote', async () => {
    ensureAnilistSourceRegistered();
    const sqlite3 = await getTestSqlite();
    const localDb = await openTestAnilistDb();
    seedMediaRow(localDb, 50);
    seedMediaRow(localDb, 51);
    localDb.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?)`,
      { bind: [50, 51, 'SEQUEL'] },
    );
    const localBytes = exportAndClose(sqlite3, localDb);

    const remoteDb = await openTestAnilistDb();
    seedMediaRow(remoteDb, 50);
    seedMediaRow(remoteDb, 52);
    remoteDb.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?)`,
      { bind: [50, 52, 'PREQUEL'] },
    );
    const remoteBytes = exportAndClose(sqlite3, remoteDb);

    const mergedBytes = pullMerge(sqlite3, localBytes, anilistSourceDescriptor.id, remoteBytes);
    const mergedDb = openDbFromBytes(sqlite3, mergedBytes);
    try {
      const edges = mergedDb.selectObjects(
        `SELECT to_media_id, relation_type
           FROM media_relation
          WHERE from_media_id = 50
          ORDER BY to_media_id`,
      );
      expect(edges).toEqual([
        { to_media_id: 51, relation_type: 'SEQUEL' },
        { to_media_id: 52, relation_type: 'PREQUEL' },
      ]);
    } finally {
      mergedDb.close();
    }
  });

  it('keeps the newer media_relations_expansion marker for the same seed', async () => {
    ensureAnilistSourceRegistered();
    const sqlite3 = await getTestSqlite();
    const localDb = await openTestAnilistDb();
    seedMediaRow(localDb, 50);
    localDb.exec(
      `INSERT INTO media_relations_expansion (media_id, fetched_at) VALUES (?, ?)`,
      { bind: [50, 100] },
    );
    const localBytes = exportAndClose(sqlite3, localDb);

    const remoteDb = await openTestAnilistDb();
    seedMediaRow(remoteDb, 50);
    remoteDb.exec(
      `INSERT INTO media_relations_expansion (media_id, fetched_at) VALUES (?, ?)`,
      { bind: [50, TEST_ANILIST_NOW] },
    );
    const remoteBytes = exportAndClose(sqlite3, remoteDb);

    const mergedBytes = pullMerge(sqlite3, localBytes, anilistSourceDescriptor.id, remoteBytes);
    const mergedDb = openDbFromBytes(sqlite3, mergedBytes);
    try {
      const marker = mergedDb.selectObject(
        'SELECT fetched_at FROM media_relations_expansion WHERE media_id = 50',
      );
      expect(marker?.fetched_at).toBe(TEST_ANILIST_NOW);
    } finally {
      mergedDb.close();
    }
  });
});
