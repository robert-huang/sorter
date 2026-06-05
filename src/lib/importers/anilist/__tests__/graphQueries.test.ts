import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor } from '../context';
import {
  describeAnimeRandomPickFailure,
  getAnimeCacheStats,
  getMediaRelations,
  getAnimeFilmographyForStaff,
  getVaCreditsAtMedia,
  hasAnimeRandomFilters,
  pickRandomAnimeFromCache,
  searchAnimeInCache,
} from '../graphQueries';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

const NOW = 1_700_000_000_000;

function makeDbAdapter(db: Database): AnilistDbExecutor {
  return {
    async exec(sql, params) {
      const isQuery = /^\s*(select|pragma)/i.test(sql);
      if (isQuery) {
        if (params && params.length > 0) {
          return db.selectObjects(sql, params as never) as never;
        }
        return db.selectObjects(sql) as never;
      }
      if (params && params.length > 0) {
        (db as unknown as ExecCapable).exec(sql, { bind: params });
      } else {
        db.exec(sql);
      }
      return [];
    },
    async execBatch(statements) {
      db.transaction(() => {
        for (const { sql, params } of statements) {
          if (params && params.length > 0) {
            (db as unknown as ExecCapable).exec(sql, { bind: params });
          } else {
            db.exec(sql);
          }
        }
      });
    },
  };
}

function seedMedia(
  db: Database,
  id: number,
  type: 'ANIME' | 'MANGA',
  startYear: number | null = null,
): void {
  db.exec(
    `INSERT INTO media (id, type, title_english, start_year, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    { bind: [id, type, `title-${id}`, startYear, NOW, NOW] },
  );
}

function seedStaff(db: Database, id: number, name: string, image: string | null = null): void {
  db.exec(
    `INSERT INTO staff (id, name_full, image, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    { bind: [id, name, image, NOW, NOW] },
  );
}

function seedCharacter(
  db: Database,
  id: number,
  name: string,
  image: string | null = null,
): void {
  db.exec(
    `INSERT INTO character (id, name_full, image, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    { bind: [id, name, image, NOW, NOW] },
  );
}

async function freshAnilistDb(): Promise<{ db: Database; adapter: AnilistDbExecutor }> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return { db, adapter: makeDbAdapter(db) };
}

describe('graphQueries cache pick', () => {
  let adapter: AnilistDbExecutor;
  let sqlite: Database;

  beforeEach(async () => {
    const fresh = await freshAnilistDb();
    adapter = fresh.adapter;
    sqlite = fresh.db;
  });

  it('getAnimeCacheStats counts anime and manga separately', async () => {
    seedMedia(sqlite, 1, 'ANIME');
    seedMedia(sqlite, 2, 'ANIME');
    seedMedia(sqlite, 3, 'MANGA');

    await expect(getAnimeCacheStats(adapter)).resolves.toEqual({
      totalMedia: 3,
      animeCount: 2,
      mangaCount: 1,
    });
  });

  it('pickRandomAnimeFromCache returns only ANIME rows', async () => {
    seedMedia(sqlite, 10, 'MANGA');
    seedMedia(sqlite, 11, 'ANIME');

    const row = await pickRandomAnimeFromCache(adapter);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(11);
    expect(row?.type).toBe('ANIME');
  });

  it('describeAnimeRandomPickFailure mentions non-persistent tab when in memory mode', () => {
    const msg = describeAnimeRandomPickFailure({
      stats: { totalMedia: 0, animeCount: 0, mangaCount: 0 },
      storageMode: 'memory',
    });
    expect(msg).toMatch(/another Sorter tab/i);
  });

  it('describeAnimeRandomPickFailure does not mention filters when none are active', () => {
    const msg = describeAnimeRandomPickFailure({
      stats: { totalMedia: 5, animeCount: 0, mangaCount: 5 },
      storageMode: 'opfs',
    });
    expect(msg).toMatch(/none are anime/i);
    expect(msg).not.toMatch(/filter/i);
  });

  it('hasAnimeRandomFilters is false for an empty filter object', () => {
    expect(hasAnimeRandomFilters({})).toBe(false);
  });

  it('getVaCreditsAtMedia maps staff and character names from aliased columns', async () => {
    seedMedia(sqlite, 100, 'ANIME');
    seedStaff(sqlite, 1, 'Voice Actor One', 'https://example.com/va.jpg');
    seedCharacter(sqlite, 2, 'Hero Character', 'https://example.com/char.jpg');
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 2, 'MAIN', 0] },
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 2, 1, 'JAPANESE'] },
    );

    const rows = await getVaCreditsAtMedia(adapter, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].staff.name_full).toBe('Voice Actor One');
    expect(rows[0].staff.image).toBe('https://example.com/va.jpg');
    expect(rows[0].character.name_full).toBe('Hero Character');
    expect(rows[0].character.image).toBe('https://example.com/char.jpg');
    expect(rows[0].characterRole).toBe('MAIN');
    expect(rows[0].characterSortOrder).toBe(0);
  });

  it('getAnimeFilmographyForStaff returns voice roles from CVA, not only staff credits', async () => {
    seedMedia(sqlite, 100, 'ANIME', 2020);
    seedMedia(sqlite, 101, 'ANIME', 2010);
    seedStaff(sqlite, 1, 'Voice Actor');
    seedCharacter(sqlite, 10, 'Hero');
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 10, 'MAIN', 0] },
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 10, 1, 'JAPANESE'] },
    );
    sqlite.exec(
      `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [101, 1, 'Theme Song Performance', 0] },
    );

    const rows = await getAnimeFilmographyForStaff(adapter, 1, 'key');
    expect(rows).toHaveLength(2);
    expect(rows[0].creditKind).toBe('voice');
    expect(rows[0].media.id).toBe(100);
    expect(rows[0].roles).toEqual(['as Hero (MAIN)']);
    expect(rows[1].creditKind).toBe('production');
    expect(rows[1].media.id).toBe(101);
    expect(rows[1].roles).toEqual(['Theme Song Performance']);
  });

  it('getAnimeFilmographyForStaff sorts voice roles by release date descending', async () => {
    seedMedia(sqlite, 100, 'ANIME', 2010);
    seedMedia(sqlite, 101, 'ANIME', 2020);
    seedStaff(sqlite, 1, 'Voice Actor');
    seedCharacter(sqlite, 10, 'Old Hero');
    seedCharacter(sqlite, 11, 'New Hero');
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      { bind: [100, 10, 'MAIN', 0, 101, 11, 'MAIN', 0] },
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      { bind: [100, 10, 1, 'JAPANESE', 101, 11, 1, 'JAPANESE'] },
    );

    const rows = await getAnimeFilmographyForStaff(adapter, 1, 'key');
    expect(rows.map((row) => row.media.id)).toEqual([101, 100]);
    expect(rows.every((row) => row.creditKind === 'voice')).toBe(true);
  });

  it('getAnimeFilmographyForStaff lists voice roles then production on the same show', async () => {
    seedMedia(sqlite, 100, 'ANIME', 2020);
    seedStaff(sqlite, 1, 'Voice Actor');
    seedCharacter(sqlite, 10, 'Hero');
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 10, 'MAIN', 0] },
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 10, 1, 'JAPANESE'] },
    );
    sqlite.exec(
      `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 1, 'Theme Song Performance', 0] },
    );

    const rows = await getAnimeFilmographyForStaff(adapter, 1, 'all');
    expect(rows).toHaveLength(2);
    expect(rows[0].creditKind).toBe('voice');
    expect(rows[0].roles).toEqual(['as Hero (MAIN)']);
    expect(rows[1].creditKind).toBe('production');
    expect(rows[1].roles).toEqual(['Theme Song Performance']);
    expect(rows[0].media.id).toBe(100);
    expect(rows[1].media.id).toBe(100);
  });

  it('getAnimeFilmographyForStaff groups multiple production roles on one show', async () => {
    seedMedia(sqlite, 100, 'ANIME', 2020);
    seedStaff(sqlite, 1, 'Singer');
    sqlite.exec(
      `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      {
        bind: [
          100, 1, 'Theme Song Performance (ED)', 0,
          100, 1, 'Theme Song Composition (ED)', 1,
        ],
      },
    );

    const rows = await getAnimeFilmographyForStaff(adapter, 1, 'all');
    expect(rows).toHaveLength(1);
    expect(rows[0].creditKind).toBe('production');
    expect(rows[0].media.id).toBe(100);
    expect(rows[0].roles).toEqual([
      'Theme Song Composition (ED)',
      'Theme Song Performance (ED)',
    ]);
  });

  it('getAnimeFilmographyForStaff returns production-only credits for non-VA staff', async () => {
    seedMedia(sqlite, 100, 'ANIME', 2015);
    seedStaff(sqlite, 1, 'Director');
    sqlite.exec(
      `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
         VALUES (?, ?, ?, ?)`,
      { bind: [100, 1, 'Director', 0] },
    );

    const rows = await getAnimeFilmographyForStaff(adapter, 1, 'key');
    expect(rows).toHaveLength(1);
    expect(rows[0].creditKind).toBe('production');
    expect(rows[0].roles).toEqual(['Director']);
  });

  it('getVaCreditsAtMedia sorts by role then AniList sort_order', async () => {
    seedMedia(sqlite, 100, 'ANIME');
    seedStaff(sqlite, 1, 'Zeta VA', null);
    seedStaff(sqlite, 2, 'Alpha VA', null);
    seedCharacter(sqlite, 10, 'Main Char', null);
    seedCharacter(sqlite, 11, 'Supporting Char', null);
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      { bind: [100, 10, 'MAIN', 1, 100, 11, 'SUPPORTING', 0] },
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      { bind: [100, 10, 1, 'JAPANESE', 100, 11, 2, 'JAPANESE'] },
    );

    const rows = await getVaCreditsAtMedia(adapter, 100);
    expect(rows.map((r) => r.characterRole)).toEqual(['MAIN', 'SUPPORTING']);
    expect(rows[0].staff.name_full).toBe('Zeta VA');
    expect(rows[1].staff.name_full).toBe('Alpha VA');
  });

  it('getMediaRelations returns franchise edges for a media id', async () => {
    seedMedia(sqlite, 50, 'ANIME');
    seedMedia(sqlite, 51, 'ANIME');
    sqlite.exec(
      `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
         VALUES (?, ?, ?)`,
      { bind: [50, 51, 'SEQUEL'] },
    );

    const rows = await getMediaRelations(adapter, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].media.id).toBe(51);
    expect(rows[0].relationType).toBe('SEQUEL');
  });

  it('searchAnimeInCache matches romaji and synonyms', async () => {
    sqlite.exec(
      `INSERT INTO media (
         id, type, title_english, title_romaji, title_native, cover_image,
         fetched_at, updated_at, synonyms_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        bind: [
          60,
          'ANIME',
          null,
          'Naruto Shippuden',
          null,
          null,
          NOW,
          NOW,
          '["NS"]',
        ],
      },
    );

    const byRomaji = await searchAnimeInCache(adapter, 'naruto', 10);
    expect(byRomaji.map((r) => r.id)).toContain(60);

    const bySynonym = await searchAnimeInCache(adapter, 'ns', 10);
    expect(bySynonym.map((r) => r.id)).toContain(60);
  });
});
