import { beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { currentVersion, migrate, migrateTo } from '../../../db/migration-runner';
import { getSource } from '../../../db/source-registry';
import {
  ANILIST_SOURCE_ID,
  anilistSourceDescriptor,
  ensureAnilistSourceRegistered,
} from '../anilistSource';

// Bump this in lock-step with the highest version in
// anilistSourceDescriptor.migrations so the "applies cleanly" sanity
// check fails loudly when someone forgets to register a new migration.
const LATEST_SCHEMA_VERSION = 2;

const EXPECTED_TABLES = [
  'anilist_user',
  'media',
  'studio',
  'tag',
  'character',
  'staff',
  'media_studio',
  'media_tag',
  'media_character',
  'character_voice_actor',
  'media_cast_expansion',
  'media_list_entry',
  'custom_list',
  'media_custom_list_membership',
  'media_favourite',
  'character_favourite',
  'staff_favourite',
  'studio_favourite',
] as const;

const EXPECTED_INDEXES = [
  'media_season',
  'media_format',
  'media_status',
  'media_mean_score',
  'media_country',
  'character_favourites',
  'staff_favourites',
  'staff_language',
  'idx_media_studio_studio',
  'idx_media_tag_tag',
  'idx_media_tag_rank',
  'idx_media_character_character',
  'media_list_status',
  'media_list_score',
  'media_list_user',
  'media_list_anilist_updated',
  'idx_mclm_list',
  'media_favourite_order',
  'character_favourite_order',
  'staff_favourite_order',
  'studio_favourite_order',
] as const;

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  // FK enforcement is per-connection. worker.ts/dbBytes.ts both set this; the
  // test helper `openMemoryDb` does not, so we mirror it here for cascades.
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

function selectTableNames(db: Database): string[] {
  const rows = db.selectObjects(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  return rows
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string');
}

function selectIndexNames(db: Database): string[] {
  // Filter out auto-generated indexes (`sqlite_autoindex_*`) that SQLite
  // creates for PRIMARY KEY / UNIQUE constraints; we only care about the
  // ones declared in the migration.
  const rows = db.selectObjects(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string');
}

const NOW = 1_700_000_000_000;
// Stable user dimension for every test that inserts into a user-scoped
// table. Matches the magic constant used in importer/favourites tests.
const USER_ID = 12345;

function seedAnilistUser(db: Database, id: number = USER_ID, name: string = 'me'): void {
  db.exec(
    'INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
    { bind: [id, name, NOW, NOW] },
  );
}

function seedMedia(db: Database, id: number, type: 'ANIME' | 'MANGA' = 'ANIME'): void {
  db.exec(
    `INSERT INTO media (id, type, title_english, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    { bind: [id, type, `title-${id}`, NOW, NOW] },
  );
}

function seedStudio(db: Database, id: number): void {
  db.exec('INSERT INTO studio (id, name, fetched_at) VALUES (?, ?, ?)', {
    bind: [id, `studio-${id}`, NOW],
  });
}

function seedTag(db: Database, name: string): void {
  db.exec('INSERT INTO tag (name, fetched_at) VALUES (?, ?)', {
    bind: [name, NOW],
  });
}

function seedCharacter(db: Database, id: number): void {
  db.exec(
    'INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
    { bind: [id, `char-${id}`, NOW, NOW] },
  );
}

function seedStaff(db: Database, id: number): void {
  db.exec(
    'INSERT INTO staff (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
    { bind: [id, `staff-${id}`, NOW, NOW] },
  );
}

function countRows(db: Database, table: string): number {
  const value = db.selectValue(`SELECT COUNT(*) FROM ${table}`);
  return typeof value === 'number' ? value : Number(value);
}

describe('anilist migration', () => {
  beforeAll(() => {
    // Some tests may indirectly load anilistSource via other test files. The
    // ensure() helper is idempotent — call it explicitly so this test file
    // is also valid in isolation.
    ensureAnilistSourceRegistered();
  });

  it('applies cleanly to a fresh in-memory DB and sets schema_version to the latest', async () => {
    const db = await freshAnilistDb();
    expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('creates every expected table', async () => {
    const db = await freshAnilistDb();
    const tables = selectTableNames(db);
    for (const expected of EXPECTED_TABLES) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('creates every expected index', async () => {
    const db = await freshAnilistDb();
    const indexes = selectIndexNames(db);
    for (const expected of EXPECTED_INDEXES) {
      expect(indexes).toContain(expected);
    }
    db.close();
  });

  it('deleting a media row cascades to all media-keyed child tables', async () => {
    const db = await freshAnilistDb();

    seedAnilistUser(db);
    seedMedia(db, 100);
    seedMedia(db, 200);
    seedStudio(db, 10);
    seedTag(db, 'romance');
    seedCharacter(db, 1000);

    db.exec('INSERT INTO media_studio (media_id, studio_id, sort_order) VALUES (?, ?, 0)', {
      bind: [100, 10],
    });
    db.exec('INSERT INTO media_tag (media_id, tag_name, rank) VALUES (?, ?, 80)', {
      bind: [100, 'romance'],
    });
    db.exec(
      `INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
         VALUES (?, ?, 'COMPLETED', ?, ?)`,
      { bind: [USER_ID, 100, NOW, NOW] },
    );
    db.exec(
      'INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 100, NOW] },
    );
    db.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, 'MAIN', 0)`,
      { bind: [100, 1000] },
    );
    db.exec(
      `INSERT INTO media_cast_expansion (media_id, language, fetched_at)
         VALUES (?, 'JAPANESE', ?)`,
      { bind: [100, NOW] },
    );

    db.exec('DELETE FROM media WHERE id = ?', { bind: [100] });

    expect(countRows(db, 'media')).toBe(1);
    expect(countRows(db, 'media_studio')).toBe(0);
    expect(countRows(db, 'media_tag')).toBe(0);
    expect(countRows(db, 'media_list_entry')).toBe(0);
    expect(countRows(db, 'media_favourite')).toBe(0);
    expect(countRows(db, 'media_character')).toBe(0);
    expect(countRows(db, 'media_cast_expansion')).toBe(0);
    // Parent metadata rows are independent and stay alive
    expect(countRows(db, 'studio')).toBe(1);
    expect(countRows(db, 'tag')).toBe(1);
    expect(countRows(db, 'character')).toBe(1);

    db.close();
  });

  // Regression — without backfill the chip's "cast cached" counter
  // would drop to 0 for every user upgrading from v1, even though their
  // already-expanded shows still have character_voice_actor rows.
  // Migration 002 must hoist those into the new media_cast_expansion
  // tracking table so the chip stays accurate across the upgrade.
  it('migration 002 backfills media_cast_expansion from existing character_voice_actor rows', async () => {
    const db = await openMemoryDb();
    db.exec('PRAGMA foreign_keys = ON');
    // Bring DB up to v1 ONLY so we can seed v1-shaped data before the
    // 002 backfill runs.
    migrateTo(db, anilistSourceDescriptor, 1);
    expect(currentVersion(db)).toBe(1);

    seedMedia(db, 100);
    seedMedia(db, 200);
    // Media 300 has NO cast data — it must NOT get a backfilled row
    // (we have no evidence it was ever expanded under v1).
    seedMedia(db, 300);
    seedCharacter(db, 1000);
    seedStaff(db, 5000);
    seedStaff(db, 5001);
    db.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, 'MAIN', 0)`,
      { bind: [100, 1000] },
    );
    db.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, 'MAIN', 0)`,
      { bind: [200, 1000] },
    );
    // Two VA rows on media 100 — backfill must collapse them to a
    // single media_cast_expansion row (PK is media_id only).
    db.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, 'JAPANESE')`,
      { bind: [100, 1000, 5000] },
    );
    db.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, 'JAPANESE')`,
      { bind: [100, 1000, 5001] },
    );
    db.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, 'JAPANESE')`,
      { bind: [200, 1000, 5000] },
    );

    migrate(db, anilistSourceDescriptor);
    expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION);

    const backfilled = db.selectObjects(
      'SELECT media_id, language, fetched_at FROM media_cast_expansion ORDER BY media_id',
    );
    expect(backfilled).toEqual([
      { media_id: 100, language: 'JAPANESE', fetched_at: 0 },
      { media_id: 200, language: 'JAPANESE', fetched_at: 0 },
    ]);

    db.close();
  });

  it('deleting a media_character row cascades to character_voice_actor', async () => {
    const db = await freshAnilistDb();
    seedMedia(db, 100);
    seedCharacter(db, 1000);
    seedStaff(db, 5000);
    db.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, 'MAIN', 0)`,
      { bind: [100, 1000] },
    );
    db.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, 'JAPANESE')`,
      { bind: [100, 1000, 5000] },
    );
    expect(countRows(db, 'character_voice_actor')).toBe(1);

    db.exec('DELETE FROM media_character WHERE media_id = ? AND character_id = ?', {
      bind: [100, 1000],
    });

    expect(countRows(db, 'character_voice_actor')).toBe(0);
    // Parent staff row should not be touched by the cascade
    expect(countRows(db, 'staff')).toBe(1);
    db.close();
  });

  it('deleting a character / staff / studio cascades to their favourites table', async () => {
    const db = await freshAnilistDb();
    seedAnilistUser(db);
    seedCharacter(db, 1000);
    seedStaff(db, 5000);
    seedStudio(db, 10);
    db.exec(
      'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 1000, NOW] },
    );
    db.exec(
      'INSERT INTO staff_favourite (anilist_user_id, staff_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 5000, NOW] },
    );
    db.exec(
      'INSERT INTO studio_favourite (anilist_user_id, studio_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 10, NOW] },
    );

    db.exec('DELETE FROM character WHERE id = ?', { bind: [1000] });
    db.exec('DELETE FROM staff WHERE id = ?', { bind: [5000] });
    db.exec('DELETE FROM studio WHERE id = ?', { bind: [10] });

    expect(countRows(db, 'character_favourite')).toBe(0);
    expect(countRows(db, 'staff_favourite')).toBe(0);
    expect(countRows(db, 'studio_favourite')).toBe(0);
    db.close();
  });

  it('deleting an anilist_user cascades to every per-user table', async () => {
    // The user dimension was added to list/fav/custom_list tables for
    // multi-user storage. Sanity-check that deleting the user wipes
    // their list, favourites, and custom lists in one go — otherwise
    // sharing the DB with a friend who then asks "remove my data"
    // would leak rows.
    const db = await freshAnilistDb();
    seedAnilistUser(db);
    seedMedia(db, 100);
    seedCharacter(db, 1000);
    seedStaff(db, 5000);
    seedStudio(db, 10);
    db.exec(
      `INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
         VALUES (?, ?, 'COMPLETED', ?, ?)`,
      { bind: [USER_ID, 100, NOW, NOW] },
    );
    db.exec(
      'INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 100, NOW] },
    );
    db.exec(
      'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 1000, NOW] },
    );
    db.exec(
      'INSERT INTO staff_favourite (anilist_user_id, staff_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 5000, NOW] },
    );
    db.exec(
      'INSERT INTO studio_favourite (anilist_user_id, studio_id, sort_order, fetched_at) VALUES (?, ?, 0, ?)',
      { bind: [USER_ID, 10, NOW] },
    );
    db.exec(
      `INSERT INTO custom_list (anilist_user_id, name, media_type, fetched_at, updated_at)
         VALUES (?, 'Top', 'ANIME', ?, ?)`,
      { bind: [USER_ID, NOW, NOW] },
    );
    db.exec(
      `INSERT INTO media_custom_list_membership
         (anilist_user_id, media_id, custom_list_name, media_type)
         VALUES (?, ?, 'Top', 'ANIME')`,
      { bind: [USER_ID, 100] },
    );

    db.exec('DELETE FROM anilist_user WHERE id = ?', { bind: [USER_ID] });

    expect(countRows(db, 'media_list_entry')).toBe(0);
    expect(countRows(db, 'media_favourite')).toBe(0);
    expect(countRows(db, 'character_favourite')).toBe(0);
    expect(countRows(db, 'staff_favourite')).toBe(0);
    expect(countRows(db, 'studio_favourite')).toBe(0);
    expect(countRows(db, 'custom_list')).toBe(0);
    expect(countRows(db, 'media_custom_list_membership')).toBe(0);
    // Globally cached metadata stays — sharing the DB with another
    // user shouldn't lose anime/manga/character/staff/studio rows.
    expect(countRows(db, 'media')).toBe(1);
    expect(countRows(db, 'character')).toBe(1);
    expect(countRows(db, 'staff')).toBe(1);
    expect(countRows(db, 'studio')).toBe(1);
    db.close();
  });

  it('deleting a media_list_entry cascades to media_custom_list_membership', async () => {
    // The importer relies on this cascade to "free" wipe memberships
    // every import — without it, renames would orphan memberships and
    // accumulate cruft.
    const db = await freshAnilistDb();
    seedAnilistUser(db);
    seedMedia(db, 100);
    db.exec(
      `INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
         VALUES (?, ?, 'COMPLETED', ?, ?)`,
      { bind: [USER_ID, 100, NOW, NOW] },
    );
    db.exec(
      `INSERT INTO custom_list (anilist_user_id, name, media_type, fetched_at, updated_at)
         VALUES (?, 'Top', 'ANIME', ?, ?)`,
      { bind: [USER_ID, NOW, NOW] },
    );
    db.exec(
      `INSERT INTO media_custom_list_membership
         (anilist_user_id, media_id, custom_list_name, media_type)
         VALUES (?, ?, 'Top', 'ANIME')`,
      { bind: [USER_ID, 100] },
    );
    expect(countRows(db, 'media_custom_list_membership')).toBe(1);

    db.exec(
      'DELETE FROM media_list_entry WHERE anilist_user_id = ? AND media_id = ?',
      { bind: [USER_ID, 100] },
    );

    expect(countRows(db, 'media_custom_list_membership')).toBe(0);
    // The custom_list row itself stays — it's GC'd by the importer
    // post-wipe, not via cascade.
    expect(countRows(db, 'custom_list')).toBe(1);
    db.close();
  });

  it('blocks insertion of a media_list_entry whose parent media does not exist', async () => {
    const db = await freshAnilistDb();
    seedAnilistUser(db);
    expect(() =>
      db.exec(
        `INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
           VALUES (?, 9999, 'COMPLETED', ?, ?)`,
        { bind: [USER_ID, NOW, NOW] },
      ),
    ).toThrow();
    db.close();
  });
});

describe('anilist source descriptor', () => {
  it('exposes merge spec with the expected metadata + user-data tables', () => {
    const meta = anilistSourceDescriptor.merge.metadataTables.map((t) => t.name);
    const user = anilistSourceDescriptor.merge.userDataTables.map((t) => t.name);
    // anilist_user is metadata (source-authoritative), media_list_entry
    // is user-data (PK now includes anilist_user_id for multi-user).
    // media_cast_expansion is metadata: it's NOT a junction (has its
    // own fetched_at), so devices that have expanded a media converge
    // on the latest attempt via row-level merge.
    expect(meta).toEqual([
      'anilist_user',
      'media',
      'studio',
      'tag',
      'character',
      'staff',
      'media_cast_expansion',
    ]);
    expect(user).toEqual(['media_list_entry']);
    const listEntry = anilistSourceDescriptor.merge.userDataTables.find(
      (t) => t.name === 'media_list_entry',
    );
    expect(listEntry?.pk).toEqual(['anilist_user_id', 'media_id']);
    const castExpansion = anilistSourceDescriptor.merge.metadataTables.find(
      (t) => t.name === 'media_cast_expansion',
    );
    expect(castExpansion?.pk).toEqual(['media_id']);
    expect(castExpansion?.timestampCol).toBe('fetched_at');
  });

  it('intentionally excludes junctions and wipe-and-rebuild tables from the merge spec', () => {
    const merged = new Set([
      ...anilistSourceDescriptor.merge.metadataTables.map((t) => t.name),
      ...anilistSourceDescriptor.merge.userDataTables.map((t) => t.name),
    ]);
    // Junctions are rebuilt by the importer; row-level merge would create
    // orphans. Favourites + custom lists + their memberships are
    // wipe-and-rebuild; row-level merge would resurrect removed entries.
    // All are intentional v1 omissions.
    for (const name of [
      'media_studio',
      'media_tag',
      'media_character',
      'character_voice_actor',
      'media_favourite',
      'character_favourite',
      'staff_favourite',
      'studio_favourite',
      'custom_list',
      'media_custom_list_membership',
    ]) {
      expect(merged.has(name)).toBe(false);
    }
  });

  it('registers under the anilist id and is idempotent', () => {
    ensureAnilistSourceRegistered();
    ensureAnilistSourceRegistered();
    const registered = getSource(ANILIST_SOURCE_ID);
    expect(registered.id).toBe(ANILIST_SOURCE_ID);
    expect(registered.migrations).toHaveLength(LATEST_SCHEMA_VERSION);
    expect(registered.migrations.map((m) => m.version)).toEqual([1, 2]);
  });
});
