import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import {
  SCRAPE_LOCK_STALE_MS,
  _clearDbSyncManifestForTesting,
  acquireScrapeLock,
  getSourceSyncMeta,
} from '../../../db/syncManifest';
import { ANILIST_SOURCE_ID, anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
  importAnilistList,
} from '../importer';
import { lastFullRefreshKey } from '../meta';
import type {
  AnilistListPageResponse,
  AnilistMediaGql,
  AnilistMediaListEntryGql,
  AnilistUserResolveResponse,
} from '../types';

// ──────────────────────────────────────────────────────────────────────
// In-memory DB adapter (wraps a real WASM SQLite connection so the
// importer's UPSERT/DELETE/INSERT SQL hits real query semantics).
// ──────────────────────────────────────────────────────────────────────

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

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

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

// ──────────────────────────────────────────────────────────────────────
// GraphQL response fixtures
// ──────────────────────────────────────────────────────────────────────

function makeMedia(id: number, overrides: Partial<AnilistMediaGql> = {}): AnilistMediaGql {
  return {
    id,
    type: 'ANIME',
    title: { english: `EN-${id}`, romaji: `RO-${id}`, native: null },
    coverImage: { large: `https://example.test/${id}.jpg` },
    format: 'TV',
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    startDate: { year: 2020, month: 1, day: 1 },
    endDate: { year: 2020, month: 3, day: 30 },
    season: 'WINTER',
    seasonYear: 2020,
    meanScore: 75,
    favourites: 100,
    countryOfOrigin: 'JP',
    genres: ['Romance'],
    synonyms: null,
    studios: { nodes: [{ id: 10, name: 'Studio-Default' }] },
    tags: [{ name: 'Tag-A', rank: 80 }],
    ...overrides,
  };
}

function makeEntry(
  mediaId: number,
  overrides: Partial<Omit<AnilistMediaListEntryGql, 'media'>> = {},
  mediaOverrides: Partial<AnilistMediaGql> = {},
): AnilistMediaListEntryGql {
  return {
    score: 88,
    status: 'COMPLETED',
    repeat: null,
    startedAt: null,
    completedAt: null,
    createdAt: null,
    updatedAt: null,
    customLists: [],
    media: makeMedia(mediaId, mediaOverrides),
    ...overrides,
  };
}

function makeListPage(
  entries: AnilistMediaListEntryGql[],
  pageInfo: { currentPage: number; hasNextPage: boolean; lastPage?: number; total?: number },
): AnilistListPageResponse {
  return {
    Page: {
      pageInfo: {
        hasNextPage: pageInfo.hasNextPage,
        currentPage: pageInfo.currentPage,
        lastPage: pageInfo.lastPage ?? null,
        total: pageInfo.total ?? null,
      },
      mediaList: entries,
    },
  };
}

/**
 * Test harness uses a single `executeQuery` mock for both the user-
 * resolution request (`query ResolveUser`) and every subsequent list
 * page. Tests previously enqueued only list-page mocks; to keep them
 * concise the harness pre-installs a default for the resolve request
 * that returns `(id: USER_ID, name: username)` so the per-test
 * pageInfo `mockResolvedValueOnce(...)` calls don't have to interleave
 * a resolve mock first.
 *
 * Stable per-test USER_ID matches the safe-character ID convention
 * (mostly — AniList ids are integers, so we use a recognizable
 * round-number constant instead of base64).
 */
const USER_ID = 12345;
const USER_NAME = 'me';

function resolveResponse(
  username: string = USER_NAME,
  id: number = USER_ID,
): AnilistUserResolveResponse {
  return { User: { id, name: username } };
}

// ──────────────────────────────────────────────────────────────────────
// Test harness
// ──────────────────────────────────────────────────────────────────────

type Harness = {
  db: Database;
  ctx: AnilistImportContext;
  executeQuery: ReturnType<typeof vi.fn>;
  autoPush: ReturnType<typeof vi.fn>;
  nowSpy: ReturnType<typeof vi.fn>;
  /**
   * Enqueue: a successful user-resolve, then each list page in order.
   * The importer's transport calls ResolveUser first then paginates,
   * so this is the natural call sequence for happy-path tests.
   *
   * Tests that need to exercise the resolve failure path should NOT
   * call this and should instead use `executeQuery.mockResolvedValueOnce`
   * directly with `{ User: null }`.
   */
  enqueueListPages(...pages: AnilistListPageResponse[]): void;
};

const T0 = 1_700_000_000_000;

async function makeHarness(): Promise<Harness> {
  const db = await freshAnilistDb();
  const executeQuery = vi.fn();
  const autoPush = vi.fn();
  let clockOffset = 0;
  const nowSpy = vi.fn(() => T0 + clockOffset++);
  const ctx: AnilistImportContext = {
    executeQuery,
    db: makeDbAdapter(db),
    now: nowSpy,
    onAutoPushRequested: autoPush,
  };
  return {
    db,
    ctx,
    executeQuery,
    autoPush,
    nowSpy,
    enqueueListPages(...pages) {
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
  const v = row?.value;
  return typeof v === 'string' ? v : null;
}

beforeEach(() => {
  _clearDbSyncManifestForTesting();
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
});

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('importAnilistList — happy path', () => {
  it('paginates every page, writes rows in a single end-of-import transaction, stamps last_full_refresh, fires autopush', async () => {
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage([makeEntry(1), makeEntry(2)], { currentPage: 1, hasNextPage: true }),
      makeListPage([makeEntry(3)], { currentPage: 2, hasNextPage: false }),
    );

    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(result).toMatchObject({
      type: 'ANIME',
      anilistUserId: USER_ID,
      username: USER_NAME,
      pagesFetched: 2,
      entriesWritten: 3,
    });
    // 1 resolve + 2 list pages = 3 GraphQL calls.
    expect(h.executeQuery).toHaveBeenCalledTimes(3);
    expect(h.executeQuery.mock.calls[0][0]).toContain('query ResolveUser');
    expect(h.executeQuery.mock.calls[1][1]).toMatchObject({ page: 1, type: 'ANIME' });
    expect(h.executeQuery.mock.calls[2][1]).toMatchObject({ page: 2, type: 'ANIME' });

    expect(countRows(h.db, 'media')).toBe(3);
    expect(countRows(h.db, 'media_list_entry')).toBe(3);
    expect(countRows(h.db, 'anilist_user')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', `WHERE anilist_user_id = ${USER_ID}`)).toBe(3);
    expect(countRows(h.db, 'studio')).toBe(1);
    expect(countRows(h.db, 'tag')).toBe(1);
    expect(countRows(h.db, 'media_studio')).toBe(3);
    expect(countRows(h.db, 'media_tag')).toBe(3);

    expect(selectMetaValue(h.db, lastFullRefreshKey(USER_ID, 'ANIME'))).not.toBeNull();
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).scrapeLock).toBeNull();
    expect(h.autoPush).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it('passes through username + perPage in the GraphQL variables', async () => {
    const h = await makeHarness();
    h.enqueueListPages(makeListPage([], { currentPage: 1, hasNextPage: false }));
    await importAnilistList(h.ctx, { username: 'evas', type: 'MANGA', perPage: 25 });
    expect(h.executeQuery).toHaveBeenCalledWith(
      expect.stringContaining('query ListPage'),
      expect.objectContaining({ username: 'evas', type: 'MANGA', perPage: 25 }),
    );
    h.db.close();
  });

  it('handles a user with an empty list (no entries written, still stamps refresh + fires autopush)', async () => {
    const h = await makeHarness();
    h.enqueueListPages(makeListPage([], { currentPage: 1, hasNextPage: false }));
    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(result).toMatchObject({ pagesFetched: 1, entriesWritten: 0 });
    expect(countRows(h.db, 'media_list_entry')).toBe(0);
    // anilist_user row was still upserted so per-user meta key resolves.
    expect(countRows(h.db, 'anilist_user', `WHERE id = ${USER_ID}`)).toBe(1);
    expect(selectMetaValue(h.db, lastFullRefreshKey(USER_ID, 'ANIME'))).not.toBeNull();
    expect(h.autoPush).toHaveBeenCalledTimes(1);
    h.db.close();
  });
});

describe('importAnilistList — user resolution', () => {
  it('throws AnilistUnknownUserError when AniList resolves the username to null', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce({ User: null });
    await expect(
      importAnilistList(h.ctx, { username: 'no-such-user', type: 'ANIME' }),
    ).rejects.toBeInstanceOf(AnilistUnknownUserError);
    // No scrape lock acquired, no autopush fired — fast-fail before lock.
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).scrapeLock).toBeNull();
    expect(h.autoPush).not.toHaveBeenCalled();
    h.db.close();
  });

  it('isolates two users in the same DB — second import does not wipe the first', async () => {
    const h = await makeHarness();
    // First user imports their list.
    h.enqueueListPages(
      makeListPage([makeEntry(1), makeEntry(2)], { currentPage: 1, hasNextPage: false }),
    );
    await importAnilistList(h.ctx, { username: 'userA', type: 'ANIME' });
    expect(countRows(h.db, 'media_list_entry', `WHERE anilist_user_id = ${USER_ID}`)).toBe(2);

    // Second user imports a different list. Override the resolve mock
    // to return a distinct user id so per-(user, type) scoping kicks in.
    const SECOND_ID = 67890;
    h.executeQuery.mockResolvedValueOnce(resolveResponse('userB', SECOND_ID));
    h.executeQuery.mockResolvedValueOnce(
      makeListPage([makeEntry(3)], { currentPage: 1, hasNextPage: false }),
    );
    await importAnilistList(h.ctx, { username: 'userB', type: 'ANIME' });

    expect(countRows(h.db, 'media_list_entry')).toBe(3);
    expect(countRows(h.db, 'media_list_entry', `WHERE anilist_user_id = ${USER_ID}`)).toBe(2);
    expect(countRows(h.db, 'media_list_entry', `WHERE anilist_user_id = ${SECOND_ID}`)).toBe(1);
    expect(countRows(h.db, 'anilist_user')).toBe(2);
    h.db.close();
  });

  it('refreshes the anilist_user.name when AniList returns a renamed user', async () => {
    const h = await makeHarness();
    // First import as 'oldname'. enqueueListPages's default resolve
    // mock uses USER_NAME, so mock manually to thread the right
    // username through the resolve response.
    h.executeQuery.mockResolvedValueOnce(resolveResponse('oldname', USER_ID));
    h.executeQuery.mockResolvedValueOnce(makeListPage([], { currentPage: 1, hasNextPage: false }));
    await importAnilistList(h.ctx, { username: 'oldname', type: 'ANIME' });
    expect(h.db.selectValue(`SELECT name FROM anilist_user WHERE id = ${USER_ID}`)).toBe(
      'oldname',
    );

    // Second import: same user id, renamed.
    h.executeQuery.mockResolvedValueOnce(resolveResponse('newname', USER_ID));
    h.executeQuery.mockResolvedValueOnce(makeListPage([], { currentPage: 1, hasNextPage: false }));
    await importAnilistList(h.ctx, { username: 'newname', type: 'ANIME' });
    expect(h.db.selectValue(`SELECT name FROM anilist_user WHERE id = ${USER_ID}`)).toBe(
      'newname',
    );
    h.db.close();
  });
});

describe('importAnilistList — custom lists', () => {
  it('upserts custom_list + membership rows for entries with customLists', async () => {
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage(
        [
          makeEntry(1, { customLists: ['Top 2023', 'Currently Watching'] }),
          makeEntry(2, { customLists: ['Top 2023'] }),
          makeEntry(3, {}),
        ],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'custom_list')).toBe(2);
    expect(countRows(h.db, 'media_custom_list_membership')).toBe(3);
    expect(
      countRows(
        h.db,
        'media_custom_list_membership',
        `WHERE custom_list_name = 'Top 2023'`,
      ),
    ).toBe(2);
    h.db.close();
  });

  it('keeps ANIME and MANGA lists with the same name as distinct buckets', async () => {
    // Verifies per-media-type separation: a user with `Top 2023` on
    // BOTH ANIME and MANGA should end up with two distinct custom_list
    // rows even though the name collides.
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage(
        [makeEntry(1, { customLists: ['Top 2023'] })],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListPage(
        [makeEntry(50, { customLists: ['Top 2023'] }, { type: 'MANGA' })],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'MANGA' });

    expect(countRows(h.db, 'custom_list', `WHERE name = 'Top 2023'`)).toBe(2);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Top 2023' AND media_type = 'ANIME'`)).toBe(1);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Top 2023' AND media_type = 'MANGA'`)).toBe(1);
    h.db.close();
  });

  it('GCs orphan custom_list rows when a list is renamed or deleted on AniList', async () => {
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage(
        [makeEntry(1, { customLists: ['Old Name'] })],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Old Name'`)).toBe(1);

    // Second import: user renamed the list. Old Name should be GC'd.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListPage(
        [makeEntry(1, { customLists: ['New Name'] })],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'custom_list', `WHERE name = 'Old Name'`)).toBe(0);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'New Name'`)).toBe(1);
    h.db.close();
  });
});

describe('importAnilistList — wipe-and-rebuild semantics', () => {
  it('removes a list entry that no longer appears on AniList', async () => {
    // First import: user has anime 1 and 2 on their list.
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage([makeEntry(1), makeEntry(2)], { currentPage: 1, hasNextPage: false }),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'media_list_entry')).toBe(2);

    // Second import: user removed anime 2 from their list. Without
    // wipe-and-rebuild the entry would linger; the wipe in step 2 of
    // buildListImportStatements drops it before reinsert.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListPage([makeEntry(1)], { currentPage: 1, hasNextPage: false }),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'media_list_entry')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 2')).toBe(0);
    // media row itself stays — favourites or other tables may reference it.
    expect(countRows(h.db, 'media', 'WHERE id = 2')).toBe(1);
    h.db.close();
  });

  it('refreshing anime list does NOT touch manga entries', async () => {
    // Seed a manga entry directly for the same user. Seed the user
    // row first so the FK on media_list_entry resolves.
    const h = await makeHarness();
    h.db.exec(`
      INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (${USER_ID}, '${USER_NAME}', 0, 0);
      INSERT INTO media (id, type, fetched_at, updated_at) VALUES (500, 'MANGA', 0, 0);
      INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
        VALUES (${USER_ID}, 500, 'COMPLETED', 0, 0);
    `);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 500')).toBe(1);

    // Run an anime refresh — should not delete the manga entry.
    h.enqueueListPages(
      makeListPage([makeEntry(1)], { currentPage: 1, hasNextPage: false }),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 500')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 1')).toBe(1);
    h.db.close();
  });

  it('removes a studio/tag junction that no longer appears on AniList for a given media', async () => {
    const h = await makeHarness();
    h.enqueueListPages(
      makeListPage(
        [
          makeEntry(
            1,
            {},
            {
              studios: { nodes: [{ id: 10, name: 'Studio-X' }] },
              tags: [{ name: 'Old', rank: 90 }],
            },
          ),
        ],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'media_tag', "WHERE tag_name = 'Old'")).toBe(1);

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListPage(
        [
          makeEntry(
            1,
            {},
            {
              studios: { nodes: [{ id: 11, name: 'Studio-Y' }] },
              tags: [{ name: 'New', rank: 75 }],
            },
          ),
        ],
        { currentPage: 1, hasNextPage: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'media_tag', "WHERE tag_name = 'Old'")).toBe(0);
    expect(countRows(h.db, 'media_tag', "WHERE tag_name = 'New'")).toBe(1);
    expect(countRows(h.db, 'media_studio', 'WHERE studio_id = 10')).toBe(0);
    expect(countRows(h.db, 'media_studio', 'WHERE studio_id = 11')).toBe(1);
    // Studios table keeps the historical row 10 (no upward cascade — fine for v1).
    expect(countRows(h.db, 'studio', 'WHERE id = 10')).toBe(1);
    h.db.close();
  });
});

describe('importAnilistList — scrape lock', () => {
  it('throws AnilistScrapeLockHeldError when another caller holds a fresh lock', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    acquireScrapeLock(ANILIST_SOURCE_ID, T0);
    await expect(
      importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' }),
    ).rejects.toBeInstanceOf(AnilistScrapeLockHeldError);
    // resolve still ran (it's pre-lock); only the lock-acquire and
    // subsequent paginate steps were skipped.
    expect(h.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.executeQuery.mock.calls[0][0]).toContain('query ResolveUser');
    h.db.close();
  });

  it('releases the lock even when the importer throws mid-flight', async () => {
    const h = await makeHarness();
    // resolve succeeds, first list-page fetch fails.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(
      importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' }),
    ).rejects.toThrow('boom');
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).scrapeLock).toBeNull();
    expect(h.autoPush).not.toHaveBeenCalled();
    h.db.close();
  });

  it('takes over a stale lock left behind by a crashed tab', async () => {
    const h = await makeHarness();
    acquireScrapeLock(ANILIST_SOURCE_ID, T0 - SCRAPE_LOCK_STALE_MS - 1000);
    h.enqueueListPages(makeListPage([], { currentPage: 1, hasNextPage: false }));
    await expect(
      importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' }),
    ).resolves.toMatchObject({ pagesFetched: 1 });
    h.db.close();
  });
});

describe('importAnilistList — mid-import failure leaves DB untouched', () => {
  it('a page-fetch error before the final commit means zero rows are written and no refresh stamp is set', async () => {
    const h = await makeHarness();
    // Pre-seed an existing list entry for the same user so we can
    // verify the wipe DIDN'T happen (errors before the batch run
    // preserve previous state). Seed the user row first.
    h.db.exec(`
      INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (${USER_ID}, '${USER_NAME}', 0, 0);
      INSERT INTO media (id, type, fetched_at, updated_at) VALUES (777, 'ANIME', 0, 0);
      INSERT INTO media_list_entry (anilist_user_id, media_id, status, fetched_at, updated_at)
        VALUES (${USER_ID}, 777, 'COMPLETED', 0, 0);
    `);

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery
      .mockResolvedValueOnce(
        makeListPage([makeEntry(1)], { currentPage: 1, hasNextPage: true }),
      )
      .mockRejectedValueOnce(new Error('429 cap reached'));

    await expect(
      importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' }),
    ).rejects.toThrow('429 cap reached');

    // No DB writes happened — the wipe + reinsert batch never ran.
    expect(countRows(h.db, 'media_list_entry')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 777')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 1')).toBe(0);
    expect(selectMetaValue(h.db, lastFullRefreshKey(USER_ID, 'ANIME'))).toBeNull();
    expect(h.autoPush).not.toHaveBeenCalled();
    h.db.close();
  });
});
