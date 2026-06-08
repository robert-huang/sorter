/**
 * Phase D: read-query coverage. Seeds an in-memory anilist.sqlite via
 * the real migration runner, hand-rolls a few rows, and asserts each
 * public read returns what the UI layers expect (cardinality, shape,
 * default-fill on missing rows).
 *
 * Mirrors the harness style of `importer.test.ts` (real WASM SQLite,
 * `AnilistDbExecutor` adapter) so call-site semantics match prod.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor } from '../context';
import {
  lastFavouritesRefreshKey,
  lastFullRefreshKey,
} from '../meta';
import {
  getAnilistUserById,
  getAnilistUserByName,
  getFavouritedMediaIds,
  getFavouritesAsItems,
  getLastFavouritesRefresh,
  getLastFullRefresh,
  getLatestAnilistUser,
  getListEntriesByMediaIds,
  getListedMedia,
  getListedMediaCount,
  getMediaByIds,
  getMediaDetail,
  getMediaIdsInUserList,
  getMediaIdsWithCachedCast,
  getMediaIdsWithDisallowedListStatus,
  getMeta,
  getStaffFilmography,
  getVoiceActorsForCandidates,
  hasMediaCharacters,
} from '../readQueries';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

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

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  // FK enforcement is per-connection. The importer's worker enables
  // it; we mirror it here so character/voice-actor inserts that
  // depend on a media row enforce the cascade correctly.
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

// ---------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------

interface SeedOptions {
  userId?: number;
  userName?: string;
  userFetchedAt?: number;
}

function seedUser(db: Database, opts: SeedOptions = {}): { id: number; name: string } {
  const id = opts.userId ?? 12345;
  const name = opts.userName ?? 'me';
  const fetched = opts.userFetchedAt ?? 1_700_000_000_000;
  db.exec(
    'INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
    { bind: [id, name, fetched, fetched] } as never,
  );
  return { id, name };
}

function seedMedia(
  db: Database,
  id: number,
  overrides: Partial<{
    type: 'ANIME' | 'MANGA';
    title_english: string | null;
    format: string | null;
    season: string | null;
    season_year: number | null;
    mean_score: number | null;
    fetched_at: number;
    updated_at: number;
    genres_json: string | null;
  }> = {},
): void {
  const row = {
    type: 'ANIME',
    title_english: `EN-${id}`,
    format: 'TV',
    season: null as string | null,
    season_year: null as number | null,
    mean_score: 75,
    fetched_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    genres_json: '["Romance"]',
    ...overrides,
  };
  db.exec(
    `INSERT INTO media (
      id, type, title_english, title_romaji, title_native, cover_image,
      format, status, episodes, chapters, start_year, start_month, start_day,
      end_year, end_month, end_day, season, season_year, mean_score, favourites,
      country_of_origin, genres_json, synonyms_json, fetched_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'FINISHED', NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    {
      bind: [
        id,
        row.type,
        row.title_english,
        row.format,
        row.season,
        row.season_year,
        row.mean_score,
        row.genres_json,
        row.fetched_at,
        row.updated_at,
      ],
    } as never,
  );
}

function seedListEntry(
  db: Database,
  userId: number,
  mediaId: number,
  anilistUpdatedAt: number,
  status: string = 'COMPLETED',
): void {
  db.exec(
    `INSERT INTO media_list_entry (
      anilist_user_id, media_id, score, status, repeat,
      started_year, started_month, started_day,
      completed_year, completed_month, completed_day,
      anilist_created_at, anilist_updated_at, fetched_at, updated_at
    ) VALUES (?, ?, 88, ?, NULL,
              NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, ?, ?, ?)`,
    {
      bind: [
        userId,
        mediaId,
        status,
        anilistUpdatedAt,
        anilistUpdatedAt,
        anilistUpdatedAt,
      ],
    } as never,
  );
}

function seedCharacterVoiceActor(
  db: Database,
  mediaId: number,
  characterId: number,
  staffId: number,
  language: string = 'JAPANESE',
): void {
  db.exec(
    `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
     VALUES (?, ?, ?, ?)`,
    { bind: [mediaId, characterId, staffId, language] } as never,
  );
}

function seedCharacter(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO character (id, name_full, fetched_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    { bind: [id, name, 1_700_000_000_000, 1_700_000_000_000] } as never,
  );
}

function seedMediaCharacter(
  db: Database,
  mediaId: number,
  characterId: number,
  sortOrder: number,
  role = 'MAIN',
): void {
  db.exec(
    `INSERT INTO media_character (media_id, character_id, role, sort_order)
     VALUES (?, ?, ?, ?)`,
    { bind: [mediaId, characterId, role, sortOrder] } as never,
  );
}

function seedFavouriteMedia(db: Database, userId: number, mediaId: number, order: number): void {
  db.exec(
    `INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at)
     VALUES (?, ?, ?, ?)`,
    { bind: [userId, mediaId, order, 1_700_000_000_000] } as never,
  );
}

function seedFavouriteCharacter(
  db: Database,
  userId: number,
  charId: number,
  order: number,
): void {
  db.exec(
    `INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at)
     VALUES (?, ?, ?, ?)`,
    { bind: [userId, charId, order, 1_700_000_000_000] } as never,
  );
}

function seedStaff(
  db: Database,
  id: number,
  nameFull: string | null,
  image: string | null = null,
): void {
  db.exec(
    `INSERT INTO staff (id, name_full, name_native, image, age, gender, language_v2, favourites, fetched_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    { bind: [id, nameFull, image, 1_700_000_000_000, 1_700_000_000_000] } as never,
  );
}

function seedMediaStaff(
  db: Database,
  mediaId: number,
  staffId: number,
  role: string,
  sortOrder: number,
): void {
  db.exec(
    `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
     VALUES (?, ?, ?, ?)`,
    { bind: [mediaId, staffId, role, sortOrder] } as never,
  );
}

function seedStaffFilmographyExpansion(
  db: Database,
  staffId: number,
  fetchedAt: number,
): void {
  db.exec(
    `INSERT INTO staff_filmography_expansion (staff_id, fetched_at)
     VALUES (?, ?)`,
    { bind: [staffId, fetchedAt] } as never,
  );
}

/**
 * Insert a media row with explicit `start_year` + `favourites` — the
 * basic `seedMedia` hard-codes both to NULL, but the filmography sort
 * orders on them so the dedicated tests need to control them.
 */
function seedMediaWithStats(
  db: Database,
  id: number,
  startYear: number | null,
  favourites: number | null,
  type: 'ANIME' | 'MANGA' = 'ANIME',
): void {
  db.exec(
    `INSERT INTO media (
      id, type, title_english, title_romaji, title_native, cover_image,
      format, status, episodes, chapters, start_year, start_month, start_day,
      end_year, end_month, end_day, season, season_year, mean_score, favourites,
      country_of_origin, genres_json, synonyms_json, fetched_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, 'TV', 'FINISHED', NULL, NULL, ?, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, ?,
              NULL, NULL, NULL, ?, ?)`,
    {
      bind: [
        id,
        type,
        `EN-${id}`,
        startYear,
        favourites,
        1_700_000_000_000,
        1_700_000_000_000,
      ],
    } as never,
  );
}

function seedFavouriteStaff(
  db: Database,
  userId: number,
  staffId: number,
  order: number,
): void {
  db.exec(
    `INSERT INTO staff_favourite (anilist_user_id, staff_id, sort_order, fetched_at)
     VALUES (?, ?, ?, ?)`,
    { bind: [userId, staffId, order, 1_700_000_000_000] } as never,
  );
}

function seedStudio(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO studio (id, name, fetched_at) VALUES (?, ?, ?)`,
    { bind: [id, name, 1_700_000_000_000] } as never,
  );
}

function seedFavouriteStudio(
  db: Database,
  userId: number,
  studioId: number,
  order: number,
): void {
  db.exec(
    `INSERT INTO studio_favourite (anilist_user_id, studio_id, sort_order, fetched_at)
     VALUES (?, ?, ?, ?)`,
    { bind: [userId, studioId, order, 1_700_000_000_000] } as never,
  );
}

function seedMeta(db: Database, key: string, value: string): void {
  db.exec(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    { bind: [key, value] } as never,
  );
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

let db: Database;
let exec: AnilistDbExecutor;

beforeEach(async () => {
  db = await freshAnilistDb();
  exec = makeDbAdapter(db);
});

describe('getMediaByIds', () => {
  it('returns rows for matching ids and ignores unknown ids', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    const rows = await getMediaByIds(exec, [1, 3, 999]);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 3]);
  });

  it('returns an empty array for an empty input (no SQL round-trip)', async () => {
    seedMedia(db, 1);
    const rows = await getMediaByIds(exec, []);
    expect(rows).toEqual([]);
  });
});

describe('getListedMedia', () => {
  it('returns media of the requested type with a list entry for the user, sorted by anilist_updated_at desc', async () => {
    const user = seedUser(db);
    seedMedia(db, 1, { title_english: 'Older' });
    seedMedia(db, 2, { title_english: 'Newer' });
    seedMedia(db, 3, { title_english: 'Manga only', type: 'MANGA' });
    seedListEntry(db, user.id, 1, 1000);
    seedListEntry(db, user.id, 2, 5000);
    seedListEntry(db, user.id, 3, 9999); // MANGA — should be filtered out

    const rows = await getListedMedia(exec, user.id, 'ANIME');
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe('getListEntriesByMediaIds', () => {
  it('maps each media id to its entry row for the given user', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedListEntry(db, user.id, 1, 1000);
    seedListEntry(db, user.id, 2, 2000);

    const map = await getListEntriesByMediaIds(exec, user.id, [1, 2, 999]);
    expect(map.size).toBe(2);
    expect(map.get(1)?.score).toBe(88);
    expect(map.get(2)?.media_id).toBe(2);
    expect(map.has(999)).toBe(false);
  });

  it('returns an empty map for an empty input id list', async () => {
    const user = seedUser(db);
    const map = await getListEntriesByMediaIds(exec, user.id, []);
    expect(map.size).toBe(0);
  });
});

describe('getMediaDetail', () => {
  it('returns null when the media row is missing', async () => {
    const detail = await getMediaDetail(exec, 999);
    expect(detail).toBeNull();
  });

  it('returns the media row plus empty arrays when no junction rows exist', async () => {
    seedMedia(db, 1);
    const detail = await getMediaDetail(exec, 1);
    expect(detail).not.toBeNull();
    expect(detail!.media.id).toBe(1);
    expect(detail!.studios).toEqual([]);
    expect(detail!.tags).toEqual([]);
    expect(detail!.characters).toEqual([]);
    expect(detail!.productionStaff).toEqual([]);
  });

  it('returns characters ordered by sort_order ASC', async () => {
    seedMedia(db, 1);
    seedCharacter(db, 10, 'Char-A');
    seedCharacter(db, 20, 'Char-B');
    seedMediaCharacter(db, 1, 20, 0); // first
    seedMediaCharacter(db, 1, 10, 1); // second
    const detail = await getMediaDetail(exec, 1);
    expect(detail!.characters.map((c) => c.character.id)).toEqual([20, 10]);
    expect(detail!.characters[0].role).toBe('MAIN');
  });
});

describe('hasMediaCharacters', () => {
  it('returns false when no media_character rows exist for the id', async () => {
    seedMedia(db, 1);
    expect(await hasMediaCharacters(exec, 1)).toBe(false);
  });

  it('returns true after one media_character row is inserted', async () => {
    seedMedia(db, 1);
    seedCharacter(db, 10, 'X');
    seedMediaCharacter(db, 1, 10, 0);
    expect(await hasMediaCharacters(exec, 1)).toBe(true);
  });
});

describe('user lookup', () => {
  it('getAnilistUserById returns the row or null', async () => {
    seedUser(db, { userId: 5, userName: 'alice', userFetchedAt: 1 });
    const found = await getAnilistUserById(exec, 5);
    expect(found?.name).toBe('alice');
    expect(await getAnilistUserById(exec, 999)).toBeNull();
  });

  it('getLatestAnilistUser returns the most-recently-fetched user', async () => {
    seedUser(db, { userId: 1, userName: 'old', userFetchedAt: 1 });
    seedUser(db, { userId: 2, userName: 'new', userFetchedAt: 500 });
    const latest = await getLatestAnilistUser(exec);
    expect(latest?.name).toBe('new');
  });

  it('getLatestAnilistUser returns null on an empty DB', async () => {
    expect(await getLatestAnilistUser(exec)).toBeNull();
  });
});

describe('meta accessors', () => {
  it('getMeta returns the stored string or null', async () => {
    seedMeta(db, 'k', 'v');
    expect(await getMeta(exec, 'k')).toBe('v');
    expect(await getMeta(exec, 'missing')).toBeNull();
  });

  it('getLastFullRefresh parses the per-user/per-type epoch-ms meta key', async () => {
    seedMeta(db, lastFullRefreshKey(1, 'ANIME'), '1700000000000');
    const ts = await getLastFullRefresh(exec, 1, 'ANIME');
    expect(ts).toBe(1_700_000_000_000);
  });

  it('getLastFullRefresh returns null when missing or non-numeric', async () => {
    expect(await getLastFullRefresh(exec, 1, 'ANIME')).toBeNull();
    seedMeta(db, lastFullRefreshKey(1, 'ANIME'), 'not-a-number');
    expect(await getLastFullRefresh(exec, 1, 'ANIME')).toBeNull();
  });

  it('getLastFavouritesRefresh parses the per-user/per-type epoch-ms meta key', async () => {
    seedMeta(db, lastFavouritesRefreshKey(1, 'CHARACTERS'), '1700000005000');
    const ts = await getLastFavouritesRefresh(exec, 1, 'CHARACTERS');
    expect(ts).toBe(1_700_000_005_000);
  });
});

describe('getFavouritedMediaIds', () => {
  it('returns the intersection of the user\u2019s favourites and the candidate id set', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedFavouriteMedia(db, user.id, 1, 0);
    seedFavouriteMedia(db, user.id, 3, 1);
    const favs = await getFavouritedMediaIds(exec, user.id, [1, 2, 3]);
    expect(Array.from(favs).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('returns an empty set for an empty candidate list', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedFavouriteMedia(db, user.id, 1, 0);
    const favs = await getFavouritedMediaIds(exec, user.id, []);
    expect(favs.size).toBe(0);
  });

  it('returns an empty set when the user has no favourites at all', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    const favs = await getFavouritedMediaIds(exec, user.id, [1]);
    expect(favs.size).toBe(0);
  });
});

describe('getAnilistUserByName', () => {
  it('returns the user row matching the typed name', async () => {
    seedUser(db, { userId: 7, userName: 'Alice', userFetchedAt: 1 });
    const found = await getAnilistUserByName(exec, 'Alice');
    expect(found?.id).toBe(7);
    expect(found?.name).toBe('Alice');
  });

  it('matches case-insensitively so "alice", "ALICE", and "Alice" all resolve', async () => {
    // AniList itself is case-insensitive for username resolution
    // — keeping the local cache lookup parity prevents the
    // "cached: N items" hint from disappearing when the user
    // types the same name with different casing than they
    // originally imported under.
    seedUser(db, { userId: 8, userName: 'Bob', userFetchedAt: 1 });
    expect((await getAnilistUserByName(exec, 'bob'))?.id).toBe(8);
    expect((await getAnilistUserByName(exec, 'BOB'))?.id).toBe(8);
    expect((await getAnilistUserByName(exec, 'Bob'))?.id).toBe(8);
  });

  it('trims whitespace before matching (paste-from-clipboard friendly)', async () => {
    seedUser(db, { userId: 9, userName: 'carol', userFetchedAt: 1 });
    expect((await getAnilistUserByName(exec, '  carol  '))?.id).toBe(9);
  });

  it('returns null for an unknown username AND for empty input (no SQL round-trip on empty)', async () => {
    seedUser(db, { userId: 10, userName: 'dave', userFetchedAt: 1 });
    expect(await getAnilistUserByName(exec, 'unknown')).toBeNull();
    expect(await getAnilistUserByName(exec, '')).toBeNull();
    expect(await getAnilistUserByName(exec, '   ')).toBeNull();
  });
});

describe('getListedMediaCount', () => {
  it('returns the count of media_list_entry rows joined to media of the given type', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3, { type: 'MANGA' });
    seedListEntry(db, user.id, 1, 100);
    seedListEntry(db, user.id, 2, 200);
    seedListEntry(db, user.id, 3, 300); // MANGA — not counted for ANIME

    expect(await getListedMediaCount(exec, user.id, 'ANIME')).toBe(2);
    expect(await getListedMediaCount(exec, user.id, 'MANGA')).toBe(1);
  });

  it('returns 0 for a user with no entries and 0 for a user that does not exist', async () => {
    const user = seedUser(db, { userId: 1, userName: 'a', userFetchedAt: 1 });
    seedMedia(db, 1);
    expect(await getListedMediaCount(exec, user.id, 'ANIME')).toBe(0);
    expect(await getListedMediaCount(exec, 9999, 'ANIME')).toBe(0);
  });

  it('does not count entries whose media row was somehow evicted (cache-eviction edge case)', async () => {
    // Importer doesn't currently evict media rows but tests should
    // pin the JOIN-not-LEFT-JOIN contract so a future refactor
    // can't accidentally inflate the count.
    const user = seedUser(db);
    seedMedia(db, 1);
    seedListEntry(db, user.id, 1, 100);
    // Now drop the media row without dropping the list entry (only
    // possible by hand-rolling — FKs are ON, but we use PRAGMA
    // defer_foreign_keys-style staged inserts in the seed helpers
    // and the schema's ON DELETE CASCADE would normally clean up
    // dependents). Disable FKs briefly to construct the bad state.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DELETE FROM media WHERE id = 1');
    db.exec('PRAGMA foreign_keys = ON');
    expect(await getListedMediaCount(exec, user.id, 'ANIME')).toBe(0);
  });
});

describe('getFavouritesAsItems', () => {
  it('returns ANIME favourites labelled via the display-preference waterfall, falling back to Untitled, with cover_image', async () => {
    const user = seedUser(db);
    seedMedia(db, 1, { title_english: 'EN-1' });
    seedMedia(db, 2, { title_english: null });
    seedFavouriteMedia(db, user.id, 1, 0);
    seedFavouriteMedia(db, user.id, 2, 1);

    const items = await getFavouritesAsItems(exec, user.id, 'ANIME');
    expect(items).toHaveLength(2);
    expect(items.map((it) => it.externalId)).toEqual([1, 2]);
    expect(items[0].label).toBe('EN-1');
    // Untitled fallback when every title column is null.
    expect(items[1].label).toBe('Untitled (2)');
  });

  it('ANIME favourites are ordered by sort_order ascending (preserving user-asserted order)', async () => {
    const user = seedUser(db);
    seedMedia(db, 1, { title_english: 'first' });
    seedMedia(db, 2, { title_english: 'second' });
    seedMedia(db, 3, { title_english: 'third' });
    seedFavouriteMedia(db, user.id, 1, 2);
    seedFavouriteMedia(db, user.id, 2, 0);
    seedFavouriteMedia(db, user.id, 3, 1);

    const items = await getFavouritesAsItems(exec, user.id, 'ANIME');
    // Sort orders 0, 1, 2 -> ids 2, 3, 1
    expect(items.map((it) => it.externalId)).toEqual([2, 3, 1]);
  });

  it('ANIME and MANGA favourites are partitioned by media.type (no cross-type leakage)', async () => {
    const user = seedUser(db);
    seedMedia(db, 1, { title_english: 'anime-1' });
    seedMedia(db, 2, { title_english: 'manga-1', type: 'MANGA' });
    seedFavouriteMedia(db, user.id, 1, 0);
    seedFavouriteMedia(db, user.id, 2, 0);

    const animeItems = await getFavouritesAsItems(exec, user.id, 'ANIME');
    expect(animeItems.map((it) => it.externalId)).toEqual([1]);

    const mangaItems = await getFavouritesAsItems(exec, user.id, 'MANGA');
    expect(mangaItems.map((it) => it.externalId)).toEqual([2]);
  });

  it('CHARACTERS favourites read name_full and fall back to name_native', async () => {
    const user = seedUser(db);
    db.exec(
      `INSERT INTO character (id, name_full, name_native, image, fetched_at, updated_at)
       VALUES (1, 'Spike Spiegel', 'スパイク', 'http://img/1', ?, ?)`,
      { bind: [1_700_000_000_000, 1_700_000_000_000] } as never,
    );
    db.exec(
      `INSERT INTO character (id, name_full, name_native, image, fetched_at, updated_at)
       VALUES (2, NULL, 'フェイ', NULL, ?, ?)`,
      { bind: [1_700_000_000_000, 1_700_000_000_000] } as never,
    );
    seedFavouriteCharacter(db, user.id, 1, 0);
    seedFavouriteCharacter(db, user.id, 2, 1);

    const items = await getFavouritesAsItems(exec, user.id, 'CHARACTERS');
    expect(items).toEqual([
      expect.objectContaining({
        externalId: 1,
        label: 'Spike Spiegel',
        imageUrl: 'http://img/1',
        searchTokens: ['Spike Spiegel', 'スパイク'],
      }),
      expect.objectContaining({
        externalId: 2,
        label: 'フェイ',
        imageUrl: null,
        searchTokens: ['フェイ'],
      }),
    ]);
  });

  it('CHARACTERS favourites synthesise a "Character #N" label when every name column is null', async () => {
    const user = seedUser(db);
    db.exec(
      `INSERT INTO character (id, name_full, name_native, image, fetched_at, updated_at)
       VALUES (99, NULL, NULL, NULL, ?, ?)`,
      { bind: [1_700_000_000_000, 1_700_000_000_000] } as never,
    );
    seedFavouriteCharacter(db, user.id, 99, 0);
    const items = await getFavouritesAsItems(exec, user.id, 'CHARACTERS');
    expect(items[0].label).toBe('Character #99');
  });

  it('STAFF favourites resolve via staff.name_full and pull staff.image', async () => {
    const user = seedUser(db);
    seedStaff(db, 10, 'Shinichiro Watanabe', 'http://img/staff/10');
    seedStaff(db, 11, null, null);
    seedFavouriteStaff(db, user.id, 10, 0);
    seedFavouriteStaff(db, user.id, 11, 1);
    const items = await getFavouritesAsItems(exec, user.id, 'STAFF');
    expect(items).toEqual([
      expect.objectContaining({
        externalId: 10,
        label: 'Shinichiro Watanabe',
        imageUrl: 'http://img/staff/10',
        searchTokens: ['Shinichiro Watanabe'],
      }),
      expect.objectContaining({
        externalId: 11,
        label: 'Staff #11',
        imageUrl: null,
        searchTokens: [],
      }),
    ]);
  });

  it('STUDIOS favourites use studio.name (no image column in schema)', async () => {
    const user = seedUser(db);
    seedStudio(db, 100, 'Sunrise');
    seedStudio(db, 101, 'Madhouse');
    seedFavouriteStudio(db, user.id, 101, 0);
    seedFavouriteStudio(db, user.id, 100, 1);
    const items = await getFavouritesAsItems(exec, user.id, 'STUDIOS');
    expect(items).toEqual([
      expect.objectContaining({
        externalId: 101,
        label: 'Madhouse',
        imageUrl: null,
        searchTokens: ['Madhouse'],
      }),
      expect.objectContaining({
        externalId: 100,
        label: 'Sunrise',
        imageUrl: null,
        searchTokens: ['Sunrise'],
      }),
    ]);
  });

  it('returns an empty array when the user has no favourites of the requested type', async () => {
    const user = seedUser(db);
    expect(await getFavouritesAsItems(exec, user.id, 'ANIME')).toEqual([]);
    expect(await getFavouritesAsItems(exec, user.id, 'CHARACTERS')).toEqual([]);
    expect(await getFavouritesAsItems(exec, user.id, 'STAFF')).toEqual([]);
    expect(await getFavouritesAsItems(exec, user.id, 'STUDIOS')).toEqual([]);
  });
});

describe('getMediaIdsWithDisallowedListStatus', () => {
  it('returns ids whose list entry has a status NOT in the allowed set', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedListEntry(db, user.id, 1, 100, 'CURRENT');
    seedListEntry(db, user.id, 2, 200, 'PLANNING');
    seedListEntry(db, user.id, 3, 300, 'DROPPED');

    const disallowed = await getMediaIdsWithDisallowedListStatus(
      exec,
      user.id,
      ['CURRENT', 'COMPLETED', 'REPEATING'],
      [1, 2, 3],
    );
    // 2 (PLANNING) and 3 (DROPPED) fail the allowed-status set; 1
    // (CURRENT) passes. Caller subtracts this from the candidate set.
    expect(Array.from(disallowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('does NOT include ids missing a list entry entirely (favourites-only items still pass through)', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2);
    // Only id 1 has a list entry — id 2 represents a favourite the
    // user never added to their list.
    seedListEntry(db, user.id, 1, 100, 'DROPPED');

    const disallowed = await getMediaIdsWithDisallowedListStatus(
      exec,
      user.id,
      ['CURRENT', 'COMPLETED', 'REPEATING'],
      [1, 2],
    );
    // 2 isn't returned even though it doesn't match the allowed
    // statuses — it has no list entry at all, and the chip semantics
    // is "exclude wrong status", not "require a list entry".
    expect(Array.from(disallowed)).toEqual([1]);
  });

  it('scopes by anilist_user_id (other users\u2019 entries do not leak)', async () => {
    const alice = seedUser(db, { userId: 1, userName: 'alice' });
    const bob = seedUser(db, { userId: 2, userName: 'bob' });
    seedMedia(db, 1);
    // Alice has it as PLANNING (disallowed), Bob has it as CURRENT
    // (allowed). Querying with alice's id should flag the media;
    // querying with bob's should not.
    seedListEntry(db, alice.id, 1, 100, 'PLANNING');
    seedListEntry(db, bob.id, 1, 100, 'CURRENT');

    const aliceDisallowed = await getMediaIdsWithDisallowedListStatus(
      exec,
      alice.id,
      ['CURRENT'],
      [1],
    );
    expect(Array.from(aliceDisallowed)).toEqual([1]);

    const bobDisallowed = await getMediaIdsWithDisallowedListStatus(
      exec,
      bob.id,
      ['CURRENT'],
      [1],
    );
    expect(Array.from(bobDisallowed)).toEqual([]);
  });

  it('returns an empty set for empty inputs (no SQL round-trip)', async () => {
    const user = seedUser(db);
    expect(
      (await getMediaIdsWithDisallowedListStatus(exec, user.id, [], [1, 2]))
        .size,
    ).toBe(0);
    expect(
      (
        await getMediaIdsWithDisallowedListStatus(
          exec,
          user.id,
          ['CURRENT'],
          [],
        )
      ).size,
    ).toBe(0);
  });
});

describe('getMediaIdsInUserList', () => {
  it('returns the subset of candidate ids with a list entry for the user (any media type)', async () => {
    const user = seedUser(db);
    seedMedia(db, 1);
    seedMedia(db, 2, { type: 'MANGA' });
    seedMedia(db, 3);
    seedListEntry(db, user.id, 1, 100);
    seedListEntry(db, user.id, 2, 200); // MANGA still counts
    // id 3 has no list entry; id 99 isn't even cached.
    const ids = await getMediaIdsInUserList(exec, user.id, [1, 2, 3, 99]);
    expect(Array.from(ids).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('scopes by user and returns empty for empty input', async () => {
    const alice = seedUser(db, { userId: 1, userName: 'alice' });
    const bob = seedUser(db, { userId: 2, userName: 'bob' });
    seedMedia(db, 1);
    seedListEntry(db, alice.id, 1, 100);
    expect(Array.from(await getMediaIdsInUserList(exec, bob.id, [1]))).toEqual([]);
    expect((await getMediaIdsInUserList(exec, alice.id, [])).size).toBe(0);
  });
});

describe('getStaffFilmography', () => {
  it('returns staff: null and an empty filmography for an unknown staff id', async () => {
    const film = await getStaffFilmography(exec, 999);
    expect(film.staff).toBeNull();
    expect(film.credits).toEqual([]);
    expect(film.fetchedAt).toBeNull();
  });

  it('merges production credits + voice roles into one row per media', async () => {
    seedStaff(db, 10, 'Hayao Person');
    seedMediaWithStats(db, 1, 2009, 100);
    seedCharacter(db, 50, 'Alphonse');
    // character_voice_actor FK requires the media_character parent row.
    seedMediaCharacter(db, 1, 50, 0);
    // Production credit AND a voice role on the same media → one merged row.
    seedMediaStaff(db, 1, 10, 'Director', 0);
    seedCharacterVoiceActor(db, 1, 50, 10);
    seedStaffFilmographyExpansion(db, 10, 1_700_000_000_000);

    const film = await getStaffFilmography(exec, 10);
    expect(film.staff?.name_full).toBe('Hayao Person');
    expect(film.fetchedAt).toBe(1_700_000_000_000);
    expect(film.credits).toHaveLength(1);
    const credit = film.credits[0];
    expect(credit.media.id).toBe(1);
    expect(credit.productionRoles).toEqual(['Director']);
    expect(credit.voicedCharacters).toEqual([{ id: 50, name: 'Alphonse' }]);
  });

  it('collects multiple distinct production roles for one media, ordered by sort_order', async () => {
    seedStaff(db, 10, 'Multi Person');
    seedMediaWithStats(db, 1, 2015, 10);
    // Same staff, two distinct roles on one show (sort_order drives order).
    seedMediaStaff(db, 1, 10, 'Series Composition', 1);
    seedMediaStaff(db, 1, 10, 'Director', 0);

    const film = await getStaffFilmography(exec, 10);
    expect(film.credits[0].productionRoles).toEqual([
      'Director',
      'Series Composition',
    ]);
  });

  it('dedupes a voiced character that appears across multiple languages', async () => {
    seedStaff(db, 10, 'VA Person');
    seedMediaWithStats(db, 1, 2000, 5);
    seedCharacter(db, 50, 'Edward');
    seedMediaCharacter(db, 1, 50, 0);
    // Same staff voices the same character in two languages (two CVA rows
    // per the (… , language) PK) — the character must list once.
    seedCharacterVoiceActor(db, 1, 50, 10, 'JAPANESE');
    seedCharacterVoiceActor(db, 1, 50, 10, 'ENGLISH');

    const film = await getStaffFilmography(exec, 10);
    expect(film.credits[0].voicedCharacters).toEqual([{ id: 50, name: 'Edward' }]);
  });

  it('orders credits by start_year desc, then favourites desc, nulls last', async () => {
    seedStaff(db, 10, 'Prolific Person');
    seedMediaWithStats(db, 1, 2010, 5);
    seedMediaWithStats(db, 2, 2020, 5);
    seedMediaWithStats(db, 3, 2020, 50); // same year as 2, more favourites
    seedMediaWithStats(db, 4, null, 999); // unknown year → sinks to bottom
    seedMediaStaff(db, 1, 10, 'Director', 0);
    seedMediaStaff(db, 2, 10, 'Director', 0);
    seedMediaStaff(db, 3, 10, 'Director', 0);
    seedMediaStaff(db, 4, 10, 'Director', 0);

    const film = await getStaffFilmography(exec, 10);
    // 2020 (fav 50) → 2020 (fav 5) → 2010 → unknown-year last.
    expect(film.credits.map((c) => c.media.id)).toEqual([3, 2, 1, 4]);
  });
});

describe('getVoiceActorsForCandidates', () => {
  function seedCast(
    db: Database,
    mediaId: number,
    characterId: number,
    staffId: number,
  ): void {
    seedMedia(db, mediaId);
    seedCharacter(db, characterId, `Char ${characterId}`);
    seedMediaCharacter(db, mediaId, characterId, 0);
    seedStaff(db, staffId, `Staff ${staffId}`);
    seedCharacterVoiceActor(db, mediaId, characterId, staffId);
  }

  it('returns the distinct VAs whose cast row joins one of the candidate media ids', async () => {
    seedCast(db, 1, 100, 1000);
    seedCast(db, 2, 101, 1001);
    // A different media not in the candidate set — its VA must not
    // surface in the chip's options.
    seedCast(db, 999, 102, 1002);

    const vas = await getVoiceActorsForCandidates(exec, [1, 2]);
    const ids = vas.map((v) => v.id).sort((a, b) => a - b);
    expect(ids).toEqual([1000, 1001]);
  });

  it('dedupes a VA that voices the same character across multiple cached shows', async () => {
    // Same staff in two different shows (e.g. recurring character).
    seedCast(db, 1, 100, 1000);
    seedMedia(db, 2);
    seedCharacter(db, 200, 'Char in Show 2');
    seedMediaCharacter(db, 2, 200, 0);
    seedCharacterVoiceActor(db, 2, 200, 1000);

    const vas = await getVoiceActorsForCandidates(exec, [1, 2]);
    expect(vas.map((v) => v.id)).toEqual([1000]);
  });

  it('returns an empty array when no candidates have cached cast yet', async () => {
    seedMedia(db, 1);
    // Media exists but no character_voice_actor rows -> nothing to
    // surface. Drives the chip's empty state.
    expect(await getVoiceActorsForCandidates(exec, [1])).toEqual([]);
  });

  it('returns an empty array for empty inputs (no SQL round-trip)', async () => {
    expect(await getVoiceActorsForCandidates(exec, [])).toEqual([]);
  });
});

describe('getMediaIdsWithCachedCast', () => {
  it('returns only candidate ids that have at least one character_voice_actor row', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedCharacter(db, 10, 'Char 10');
    seedMediaCharacter(db, 1, 10, 0);
    seedStaff(db, 100, 'VA 100');
    seedCharacterVoiceActor(db, 1, 10, 100);
    // Media 2 has a character but no VA row (e.g. AniList returned
    // no voice actors for the requested language).
    seedCharacter(db, 20, 'Char 20');
    seedMediaCharacter(db, 2, 20, 0);

    const cached = await getMediaIdsWithCachedCast(exec, [1, 2, 3]);
    // 1 has a VA row -> cached. 2 has a character but no VA -> NOT
    // cached. 3 has nothing -> not cached.
    expect(Array.from(cached).sort((a, b) => a - b)).toEqual([1]);
  });

  it('returns an empty set for empty inputs', async () => {
    expect((await getMediaIdsWithCachedCast(exec, [])).size).toBe(0);
  });
});
