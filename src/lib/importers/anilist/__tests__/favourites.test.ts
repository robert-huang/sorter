import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import {
  _clearDbSyncManifestForTesting,
  acquireScrapeLock,
  getSourceSyncMeta,
} from '../../../db/syncManifest';
import { ANILIST_SOURCE_ID, anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import { importAnilistFavourites } from '../favourites';
import { AnilistScrapeLockHeldError } from '../importer';
import { lastFavouritesRefreshKey } from '../meta';
import type {
  AnilistCharacterGql,
  AnilistFavouriteEdge,
  AnilistFavouriteStudioNode,
  AnilistFavouritesPageResponse,
  AnilistMediaGql,
  AnilistStaffGql,
  AnilistUserResolveResponse,
} from '../types';

// ── DB adapter (identical shape to importer / lazy tests) ──

type ExecCapable = { exec: (sql: string, opts?: { bind?: unknown }) => void };

function makeDbAdapter(db: Database): AnilistDbExecutor {
  function runStatement(sql: string, params: readonly unknown[] | undefined): void {
    if (params && params.length > 0) {
      (db as unknown as ExecCapable).exec(sql, { bind: params });
    } else {
      db.exec(sql);
    }
  }
  return {
    async exec(sql, params) {
      const trimmed = sql.trim().toLowerCase();
      const isQuery = trimmed.startsWith('select') || trimmed.startsWith('pragma');
      if (isQuery) {
        if (params && params.length > 0) {
          return db.selectObjects(sql, params as never) as never;
        }
        return db.selectObjects(sql) as never;
      }
      runStatement(sql, params);
      return [];
    },
    async execBatch(statements) {
      db.transaction(() => {
        for (const { sql, params } of statements) {
          runStatement(sql, params);
        }
      });
    },
  };
}

const NOW = 1_700_000_000_000;
const USER_ID = 12345;
const USER_NAME = 'me';

function resolveResponse(
  username: string = USER_NAME,
  id: number = USER_ID,
): AnilistUserResolveResponse {
  return { User: { id, name: username } };
}

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

type Harness = {
  db: Database;
  ctx: AnilistImportContext;
  executeQuery: ReturnType<typeof vi.fn>;
  autoPush: ReturnType<typeof vi.fn>;
  /**
   * Enqueue: a successful user-resolve, then each favourites page in
   * order. The importer's transport calls ResolveUser first then
   * paginates, so this is the natural call sequence for happy paths.
   */
  enqueueFavPages(...pages: AnilistFavouritesPageResponse<unknown>[]): void;
};

async function makeHarness(): Promise<Harness> {
  const db = await freshAnilistDb();
  const executeQuery = vi.fn();
  const autoPush = vi.fn();
  const ctx: AnilistImportContext = {
    executeQuery,
    db: makeDbAdapter(db),
    now: () => NOW,
    onAutoPushRequested: autoPush,
  };
  return {
    db,
    ctx,
    executeQuery,
    autoPush,
    enqueueFavPages(...pages) {
      executeQuery.mockResolvedValueOnce(resolveResponse());
      for (const page of pages) {
        executeQuery.mockResolvedValueOnce(page);
      }
    },
  };
}

function countRows(db: Database, table: string, where = ''): number {
  const value = db.selectValue(`SELECT COUNT(*) FROM ${table} ${where}`);
  return typeof value === 'number' ? value : Number(value);
}

function selectMetaValue(db: Database, key: string): string | null {
  const row = db.selectObject('SELECT value FROM _meta WHERE key = ?', [key]);
  return typeof row?.value === 'string' ? row.value : null;
}

// ── Fixtures ──

function makeMedia(id: number, type: 'ANIME' | 'MANGA'): AnilistMediaGql {
  return {
    id,
    type,
    title: { english: `${type}-${id}`, romaji: null, native: null },
    coverImage: { large: null },
    format: null,
    status: null,
    episodes: null,
    chapters: null,
    startDate: null,
    endDate: null,
    season: null,
    seasonYear: null,
    meanScore: null,
    favourites: 1,
    countryOfOrigin: null,
    genres: null,
    synonyms: null,
    studios: { nodes: [{ id: 10, name: 'Studio-X' }] },
    tags: [{ name: 'Tag-Y', rank: 70 }],
  };
}

function makeMediaFavPage(
  edges: AnilistFavouriteEdge<AnilistMediaGql>[],
  connectionKey: 'anime' | 'manga',
  hasNextPage: boolean,
): AnilistFavouritesPageResponse<AnilistMediaGql> {
  return {
    User: {
      favourites: {
        [connectionKey]: {
          pageInfo: { hasNextPage, currentPage: 1 },
          edges,
        },
      },
    },
  };
}

function makeCharFavPage(
  edges: AnilistFavouriteEdge<AnilistCharacterGql>[],
  hasNextPage: boolean,
): AnilistFavouritesPageResponse<AnilistCharacterGql> {
  return {
    User: {
      favourites: {
        characters: {
          pageInfo: { hasNextPage, currentPage: 1 },
          edges,
        },
      },
    },
  };
}

function makeStaffFavPage(
  edges: AnilistFavouriteEdge<AnilistStaffGql>[],
  hasNextPage: boolean,
): AnilistFavouritesPageResponse<AnilistStaffGql> {
  return {
    User: {
      favourites: {
        staff: {
          pageInfo: { hasNextPage, currentPage: 1 },
          edges,
        },
      },
    },
  };
}

function makeStudioFavPage(
  edges: AnilistFavouriteEdge<AnilistFavouriteStudioNode>[],
  hasNextPage: boolean,
): AnilistFavouritesPageResponse<AnilistFavouriteStudioNode> {
  return {
    User: {
      favourites: {
        studios: {
          pageInfo: { hasNextPage, currentPage: 1 },
          edges,
        },
      },
    },
  };
}

beforeEach(() => {
  _clearDbSyncManifestForTesting();
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
});

// ──────────────────────────────────────────────────────────────────────
// ANIME / MANGA
// ──────────────────────────────────────────────────────────────────────

describe('importAnilistFavourites — ANIME', () => {
  it('paginates, wipes scoped to (user, ANIME), seeds media + studio + tag + media_favourite, bumps _meta, autopushes', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(
      makeMediaFavPage(
        [
          { favouriteOrder: 0, node: makeMedia(1, 'ANIME') },
          { favouriteOrder: 1, node: makeMedia(2, 'ANIME') },
        ],
        'anime',
        true,
      ),
      makeMediaFavPage(
        [{ favouriteOrder: 2, node: makeMedia(3, 'ANIME') }],
        'anime',
        false,
      ),
    );

    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'ANIME',
    });

    expect(result).toEqual({
      type: 'ANIME',
      anilistUserId: USER_ID,
      username: USER_NAME,
      pagesFetched: 2,
      favouritesWritten: 3,
    });
    expect(countRows(h.db, 'media_favourite')).toBe(3);
    expect(countRows(h.db, 'anilist_user')).toBe(1);
    expect(
      countRows(h.db, 'media_favourite', `WHERE anilist_user_id = ${USER_ID}`),
    ).toBe(3);
    expect(countRows(h.db, 'media')).toBe(3);
    expect(countRows(h.db, 'studio')).toBe(1);
    expect(countRows(h.db, 'tag')).toBe(1);
    expect(countRows(h.db, 'media_studio')).toBe(3);
    expect(countRows(h.db, 'media_tag')).toBe(3);
    // sort_order preserved from favouriteOrder
    const ordered = h.db.selectObjects(
      'SELECT media_id, sort_order FROM media_favourite ORDER BY sort_order',
    );
    expect(ordered).toEqual([
      { media_id: 1, sort_order: 0 },
      { media_id: 2, sort_order: 1 },
      { media_id: 3, sort_order: 2 },
    ]);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'ANIME'))).toBe(String(NOW));
    expect(h.autoPush).toHaveBeenCalledTimes(1);
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).scrapeLock).toBeNull();
    h.db.close();
  });

  it('wipe is scoped to (user, media.type) — refreshing this user\'s ANIME favs leaves their MANGA favs and other users\' favs intact', async () => {
    const h = await makeHarness();
    // Pre-seed an existing MANGA favourite for the same user, AND an
    // ANIME favourite for a different user. Both must survive.
    const OTHER_ID = 99999;
    h.db.exec(
      `INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES
         (${USER_ID}, '${USER_NAME}', 0, 0),
         (${OTHER_ID}, 'other', 0, 0)`,
    );
    h.db.exec(
      'INSERT INTO media (id, type, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
      { bind: [500, 'MANGA', NOW - 1000, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO media (id, type, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
      { bind: [777, 'ANIME', NOW - 1000, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at) VALUES (?, ?, ?, ?)',
      { bind: [USER_ID, 500, 0, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at) VALUES (?, ?, ?, ?)',
      { bind: [OTHER_ID, 777, 0, NOW - 1000] },
    );

    h.enqueueFavPages(
      makeMediaFavPage(
        [{ favouriteOrder: 0, node: makeMedia(1, 'ANIME') }],
        'anime',
        false,
      ),
    );
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'ANIME' });

    // Same user's MANGA favourite intact.
    expect(
      countRows(h.db, 'media_favourite', `WHERE anilist_user_id = ${USER_ID} AND media_id = 500`),
    ).toBe(1);
    // Other user's ANIME favourite intact.
    expect(
      countRows(h.db, 'media_favourite', `WHERE anilist_user_id = ${OTHER_ID} AND media_id = 777`),
    ).toBe(1);
    // New ANIME favourite added for the imported user.
    expect(
      countRows(h.db, 'media_favourite', `WHERE anilist_user_id = ${USER_ID} AND media_id = 1`),
    ).toBe(1);
    h.db.close();
  });
});

describe('importAnilistFavourites — MANGA', () => {
  it('uses the manga connection and bumps the (user, MANGA) timestamp key', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(
      makeMediaFavPage(
        [{ favouriteOrder: 0, node: makeMedia(10, 'MANGA') }],
        'manga',
        false,
      ),
    );
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'MANGA' });
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'MANGA'))).toBe(String(NOW));
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'ANIME'))).toBeNull();
    h.db.close();
  });
});

// ──────────────────────────────────────────────────────────────────────
// CHARACTERS / STAFF / STUDIOS
// ──────────────────────────────────────────────────────────────────────

describe('importAnilistFavourites — CHARACTERS', () => {
  it('wipes this user\'s character_favourite entries and re-inserts from fresh edges', async () => {
    const h = await makeHarness();
    // Pre-seed an existing favourite (for this user) that the new
    // fetch will NOT include.
    h.db.exec(
      `INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (${USER_ID}, '${USER_NAME}', 0, 0)`,
    );
    h.db.exec(
      'INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
      { bind: [555, 'Old Fav', NOW - 1000, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) VALUES (?, ?, ?, ?)',
      { bind: [USER_ID, 555, 0, NOW - 1000] },
    );

    const char: AnilistCharacterGql = {
      id: 1000,
      name: { full: 'New Fav', native: null, alternative: null, alternativeSpoiler: null },
      image: null,
      age: null,
      gender: null,
      favourites: 50,
    };
    h.enqueueFavPages(makeCharFavPage([{ favouriteOrder: 0, node: char }], false));

    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'CHARACTERS' });

    // Old favourite gone, new favourite present
    expect(countRows(h.db, 'character_favourite', 'WHERE character_id = 555')).toBe(0);
    expect(countRows(h.db, 'character_favourite', 'WHERE character_id = 1000')).toBe(1);
    // The old `character` row stays (no upward cascade) — that's fine
    expect(countRows(h.db, 'character', 'WHERE id = 555')).toBe(1);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'CHARACTERS'))).toBe(String(NOW));
    h.db.close();
  });

  it('seeds the parent character row for a favourite never seen via a media detail panel', async () => {
    const h = await makeHarness();
    const char: AnilistCharacterGql = {
      id: 2000,
      name: { full: 'Brand New', native: null, alternative: null, alternativeSpoiler: null },
      image: null,
      age: null,
      gender: null,
      favourites: 10,
    };
    h.enqueueFavPages(makeCharFavPage([{ favouriteOrder: 0, node: char }], false));
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'CHARACTERS' });
    const row = h.db.selectObject('SELECT name_full FROM character WHERE id = 2000');
    expect(row?.name_full).toBe('Brand New');
    h.db.close();
  });
});

describe('importAnilistFavourites — STAFF', () => {
  it('wipes this user\'s staff_favourite entries and re-inserts, persisting languageV2', async () => {
    const h = await makeHarness();
    const staff: AnilistStaffGql = {
      id: 5000,
      name: { full: 'Staff Person', native: null },
      languageV2: 'Japanese',
      image: null,
      age: null,
      gender: null,
      favourites: 5,
    };
    h.enqueueFavPages(makeStaffFavPage([{ favouriteOrder: 0, node: staff }], false));
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'STAFF' });
    expect(countRows(h.db, 'staff_favourite')).toBe(1);
    expect(countRows(h.db, 'staff', 'WHERE id = 5000')).toBe(1);
    // Per-row languageV2 should be persisted, not just the favourite link.
    const row = h.db.selectObject('SELECT language_v2 FROM staff WHERE id = 5000');
    expect(row?.language_v2).toBe('Japanese');
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'STAFF'))).toBe(String(NOW));
    h.db.close();
  });
});

describe('importAnilistFavourites — STUDIOS', () => {
  it('wipes this user\'s studio_favourite entries and re-inserts with sort_order preserved', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(
      makeStudioFavPage(
        [
          { favouriteOrder: 1, node: { id: 10, name: 'A' } },
          { favouriteOrder: 0, node: { id: 11, name: 'B' } },
        ],
        false,
      ),
    );
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'STUDIOS' });
    const ordered = h.db.selectObjects(
      'SELECT studio_id, sort_order FROM studio_favourite ORDER BY sort_order',
    );
    expect(ordered).toEqual([
      { studio_id: 11, sort_order: 0 },
      { studio_id: 10, sort_order: 1 },
    ]);
    h.db.close();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Empty result regressions — mirrors importer.test.ts's empty-list case.
//
// AniList legitimately returns a connection with zero edges in two
// common cases: a brand-new user, or a user who has never favourited
// anything of this type. The importer must:
//
//   - upsert the anilist_user row (so per-(user, type) meta keys
//     resolve later — otherwise the "refreshed Xm ago" hint stays
//     "never" forever after a successful empty refresh)
//   - wipe the corresponding <type>_favourite table for this user
//     (handles "user unfavourited every entry since last refresh")
//   - stamp the per-(user, type) _meta key (proof the refresh ran)
//   - fire autopush so the empty-state delta hits the cloud
//   - emit `favouritesWritten: 0` so the UI can tell apart "we
//     successfully refreshed an empty list" from "an error happened
//     and we have nothing"
//   - NOT emit any IN(?, ?, ?) statement with zero placeholders
//     (that would be a SQL syntax error blowing the whole batch)
// ──────────────────────────────────────────────────────────────────────

describe('importAnilistFavourites — empty result handling', () => {
  it('ANIME empty: upserts user, wipes, stamps, autopushes — no error, 0 written', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(makeMediaFavPage([], 'anime', false));
    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'ANIME',
    });
    expect(result).toMatchObject({ favouritesWritten: 0, pagesFetched: 1 });
    expect(countRows(h.db, 'media_favourite')).toBe(0);
    expect(countRows(h.db, 'anilist_user', `WHERE id = ${USER_ID}`)).toBe(1);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'ANIME'))).toBe(String(NOW));
    expect(h.autoPush).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it('MANGA empty: same shape as ANIME, scoped to the MANGA meta key', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(makeMediaFavPage([], 'manga', false));
    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'MANGA',
    });
    expect(result).toMatchObject({ favouritesWritten: 0 });
    expect(countRows(h.db, 'media_favourite')).toBe(0);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'MANGA'))).toBe(String(NOW));
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'ANIME'))).toBeNull();
    h.db.close();
  });

  it('CHARACTERS empty: wipes character_favourite for this user, stamps, autopushes', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(makeCharFavPage([], false));
    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'CHARACTERS',
    });
    expect(result).toMatchObject({ favouritesWritten: 0 });
    expect(countRows(h.db, 'character_favourite')).toBe(0);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'CHARACTERS'))).toBe(String(NOW));
    expect(h.autoPush).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it('STAFF empty: wipes staff_favourite for this user, stamps, autopushes', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(makeStaffFavPage([], false));
    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'STAFF',
    });
    expect(result).toMatchObject({ favouritesWritten: 0 });
    expect(countRows(h.db, 'staff_favourite')).toBe(0);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'STAFF'))).toBe(String(NOW));
    h.db.close();
  });

  it('STUDIOS empty: wipes studio_favourite for this user, stamps, autopushes', async () => {
    const h = await makeHarness();
    h.enqueueFavPages(makeStudioFavPage([], false));
    const result = await importAnilistFavourites(h.ctx, {
      username: USER_NAME,
      type: 'STUDIOS',
    });
    expect(result).toMatchObject({ favouritesWritten: 0 });
    expect(countRows(h.db, 'studio_favourite')).toBe(0);
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'STUDIOS'))).toBe(String(NOW));
    h.db.close();
  });

  it('empty wipe still scrubs stale rows — refreshing into 0 edges clears the user\'s existing favourites', async () => {
    // The wipe-on-empty contract: if the user unfavourited everything
    // since the last refresh, the local cache must reflect that. A
    // bug where the importer short-circuited on empty edges and
    // skipped the wipe would silently keep stale favourites around.
    const h = await makeHarness();
    h.db.exec(
      `INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (${USER_ID}, '${USER_NAME}', 0, 0)`,
    );
    h.db.exec(
      'INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
      { bind: [999, 'Stale Fav', NOW - 1000, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) VALUES (?, ?, ?, ?)',
      { bind: [USER_ID, 999, 0, NOW - 1000] },
    );
    expect(countRows(h.db, 'character_favourite')).toBe(1);

    h.enqueueFavPages(makeCharFavPage([], false));
    await importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'CHARACTERS' });

    expect(countRows(h.db, 'character_favourite')).toBe(0);
    // Parent character row survives — that's by design (no upward
    // cascade) since it may still be referenced by media_character
    // junctions or another user's favourites.
    expect(countRows(h.db, 'character', 'WHERE id = 999')).toBe(1);
    h.db.close();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

describe('importAnilistFavourites — failure semantics', () => {
  it('a mid-fetch failure leaves the DB completely untouched (wipe-and-rebuild contract)', async () => {
    const h = await makeHarness();
    // Pre-seed an existing favourite — it must survive a failed refresh
    h.db.exec(
      `INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (${USER_ID}, '${USER_NAME}', 0, 0)`,
    );
    h.db.exec(
      'INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
      { bind: [555, 'Survivor', NOW - 1000, NOW - 1000] },
    );
    h.db.exec(
      'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) VALUES (?, ?, ?, ?)',
      { bind: [USER_ID, 555, 0, NOW - 1000] },
    );

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery
      .mockResolvedValueOnce(
        makeCharFavPage(
          [
            {
              favouriteOrder: 0,
              node: {
                id: 1,
                name: { full: 'A', native: null, alternative: null, alternativeSpoiler: null },
                image: null,
                age: null,
                gender: null,
                favourites: 1,
              },
            },
          ],
          true,
        ),
      )
      .mockRejectedValueOnce(new Error('boom on page 2'));

    await expect(
      importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'CHARACTERS' }),
    ).rejects.toThrow('boom on page 2');

    // Pre-existing favourite still there — no wipe happened because we
    // bailed before the transaction
    expect(countRows(h.db, 'character_favourite', 'WHERE character_id = 555')).toBe(1);
    // No new character row inserted either
    expect(countRows(h.db, 'character', 'WHERE id = 1')).toBe(0);
    // No timestamp bumped
    expect(selectMetaValue(h.db, lastFavouritesRefreshKey(USER_ID, 'CHARACTERS'))).toBeNull();
    // No autopush
    expect(h.autoPush).not.toHaveBeenCalled();
    // Lock released
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).scrapeLock).toBeNull();
    h.db.close();
  });

  it('throws AnilistScrapeLockHeldError if another caller holds a fresh lock', async () => {
    const h = await makeHarness();
    // ResolveUser still runs (pre-lock); lock acquisition fails after.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    acquireScrapeLock(ANILIST_SOURCE_ID, NOW);
    await expect(
      importAnilistFavourites(h.ctx, { username: USER_NAME, type: 'CHARACTERS' }),
    ).rejects.toBeInstanceOf(AnilistScrapeLockHeldError);
    expect(h.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.executeQuery.mock.calls[0][0]).toContain('query ResolveUser');
    h.db.close();
  });
});
