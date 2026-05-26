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
  getFavouritedMediaIds,
  getLastFavouritesRefresh,
  getLastFullRefresh,
  getLatestAnilistUser,
  getListEntriesByMediaIds,
  getListedMedia,
  getMediaByIds,
  getMediaDetail,
  getMeta,
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
): void {
  db.exec(
    `INSERT INTO media_list_entry (
      anilist_user_id, media_id, score, status, repeat,
      started_year, started_month, started_day,
      completed_year, completed_month, completed_day,
      anilist_created_at, anilist_updated_at, fetched_at, updated_at
    ) VALUES (?, ?, 88, 'COMPLETED', NULL,
              NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, ?, ?, ?)`,
    { bind: [userId, mediaId, anilistUpdatedAt, anilistUpdatedAt, anilistUpdatedAt] } as never,
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
    // staff currently unused by the schema; v1 placeholder.
    expect(detail!.staff).toEqual([]);
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
