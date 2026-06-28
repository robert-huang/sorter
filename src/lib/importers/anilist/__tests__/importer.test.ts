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
  AnilistListCollectionResponse,
  AnilistMediaGql,
  AnilistMediaListEntryGql,
  AnilistMediaListGroupGql,
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
    source: null,
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
    notes: null,
    customLists: [],
    media: makeMedia(mediaId, mediaOverrides),
    ...overrides,
  };
}

/**
 * Build an `asArray: true` customLists payload from a list of names
 * that should all be marked enabled. Mirrors the common case where a
 * test cares about "this entry IS in lists X and Y" — the AniList
 * wire shape is awkward to spell out per-entry, but the importer
 * only differentiates by the `enabled` flag.
 *
 * For tests that need to exercise the disabled-flag handling (entries
 * where AniList returns `{name, enabled: false}` because the user has
 * defined the list but not added the entry to it), build the array
 * literally with explicit `{name, enabled}` objects.
 */
function customLists(
  ...names: string[]
): AnilistMediaListEntryGql['customLists'] {
  return names.map((name) => ({ name, enabled: true }));
}

/**
 * Build a `MediaListCollection` chunk response. The importer flattens
 * all groups before doing anything with them, so the default fixture
 * just bundles everything into a single status group — callers that
 * specifically want to exercise the cross-group dedup path can pass
 * an explicit `groups` array instead via {@link makeListChunkGroups}.
 */
function makeListChunk(
  entries: AnilistMediaListEntryGql[],
  opts: { hasNextChunk: boolean },
): AnilistListCollectionResponse {
  return {
    MediaListCollection: {
      hasNextChunk: opts.hasNextChunk,
      lists: [
        {
          name: 'Completed',
          isCustomList: false,
          status: 'COMPLETED',
          entries,
        },
      ],
    },
  };
}

/**
 * Build a `MediaListCollection` chunk with caller-controlled groups —
 * used when a test needs to verify that the same entry appearing in
 * multiple groups (status + custom list) collapses to one DB row.
 */
function makeListChunkGroups(
  groups: AnilistMediaListGroupGql[],
  opts: { hasNextChunk: boolean },
): AnilistListCollectionResponse {
  return {
    MediaListCollection: { hasNextChunk: opts.hasNextChunk, lists: groups },
  };
}

/**
 * Test harness uses a single `executeQuery` mock for both the user-
 * resolution request (`query ResolveUser`) and every subsequent
 * `MediaListCollection` chunk. The harness pre-installs a default
 * resolve response that returns `(id: USER_ID, name: username)` so
 * the per-test `mockResolvedValueOnce(...)` calls don't have to
 * interleave a resolve mock first.
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
   * Enqueue: a successful user-resolve, then each list chunk in order.
   * The importer's transport calls ResolveUser first then fetches one
   * `MediaListCollection` chunk per iteration, so this is the natural
   * call sequence for happy-path tests.
   *
   * Tests that need to exercise the resolve failure path should NOT
   * call this and should instead use `executeQuery.mockResolvedValueOnce`
   * directly with `{ User: null }`.
   */
  enqueueListChunks(...chunks: AnilistListCollectionResponse[]): void;
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
    enqueueListChunks(...chunks) {
      executeQuery.mockResolvedValueOnce(resolveResponse());
      for (const chunk of chunks) {
        executeQuery.mockResolvedValueOnce(chunk);
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
  it('fetches every chunk, writes rows in a single end-of-import transaction, stamps last_full_refresh, fires autopush', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk([makeEntry(1), makeEntry(2)], { hasNextChunk: true }),
      makeListChunk([makeEntry(3)], { hasNextChunk: false }),
    );

    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(result).toMatchObject({
      type: 'ANIME',
      anilistUserId: USER_ID,
      username: USER_NAME,
      chunksFetched: 2,
      entriesWritten: 3,
    });
    // 1 resolve + 2 list chunks = 3 GraphQL calls.
    expect(h.executeQuery).toHaveBeenCalledTimes(3);
    expect(h.executeQuery.mock.calls[0][0]).toContain('query ResolveUser');
    expect(h.executeQuery.mock.calls[1][1]).toMatchObject({ chunk: 1, type: 'ANIME' });
    expect(h.executeQuery.mock.calls[2][1]).toMatchObject({ chunk: 2, type: 'ANIME' });

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

  it('passes through username + perChunk in the GraphQL variables', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(makeListChunk([], { hasNextChunk: false }));
    await importAnilistList(h.ctx, { username: 'evas', type: 'MANGA', perChunk: 25 });
    expect(h.executeQuery).toHaveBeenCalledWith(
      expect.stringContaining('query ListCollection'),
      expect.objectContaining({
        username: 'evas',
        type: 'MANGA',
        perChunk: 25,
        chunk: 1,
      }),
    );
    h.db.close();
  });

  it('handles a user with an empty list (no entries written, still stamps refresh + fires autopush)', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(makeListChunk([], { hasNextChunk: false }));
    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(result).toMatchObject({ chunksFetched: 1, entriesWritten: 0 });
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
    h.enqueueListChunks(
      makeListChunk([makeEntry(1), makeEntry(2)], { hasNextChunk: false }),
    );
    await importAnilistList(h.ctx, { username: 'userA', type: 'ANIME' });
    expect(countRows(h.db, 'media_list_entry', `WHERE anilist_user_id = ${USER_ID}`)).toBe(2);

    // Second user imports a different list. Override the resolve mock
    // to return a distinct user id so per-(user, type) scoping kicks in.
    const SECOND_ID = 67890;
    h.executeQuery.mockResolvedValueOnce(resolveResponse('userB', SECOND_ID));
    h.executeQuery.mockResolvedValueOnce(
      makeListChunk([makeEntry(3)], { hasNextChunk: false }),
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
    h.executeQuery.mockResolvedValueOnce(makeListChunk([], { hasNextChunk: false }));
    await importAnilistList(h.ctx, { username: 'oldname', type: 'ANIME' });
    expect(h.db.selectValue(`SELECT name FROM anilist_user WHERE id = ${USER_ID}`)).toBe(
      'oldname',
    );

    // Second import: same user id, renamed.
    h.executeQuery.mockResolvedValueOnce(resolveResponse('newname', USER_ID));
    h.executeQuery.mockResolvedValueOnce(makeListChunk([], { hasNextChunk: false }));
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
    h.enqueueListChunks(
      makeListChunk(
        [
          makeEntry(1, { customLists: customLists('Top 2023', 'Currently Watching') }),
          makeEntry(2, { customLists: customLists('Top 2023') }),
          makeEntry(3, {}),
        ],
        { hasNextChunk: false },
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
    h.enqueueListChunks(
      makeListChunk(
        [makeEntry(1, { customLists: customLists('Top 2023') })],
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListChunk(
        [makeEntry(50, { customLists: customLists('Top 2023') }, { type: 'MANGA' })],
        { hasNextChunk: false },
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
    h.enqueueListChunks(
      makeListChunk(
        [makeEntry(1, { customLists: customLists('Old Name') })],
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Old Name'`)).toBe(1);

    // Second import: user renamed the list. Old Name should be GC'd.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListChunk(
        [makeEntry(1, { customLists: customLists('New Name') })],
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'custom_list', `WHERE name = 'Old Name'`)).toBe(0);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'New Name'`)).toBe(1);
    h.db.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // Regression: AniList's `customLists(asArray: true)` actually returns
  // `Array<{name, enabled}>`, NOT `string[]` — the importer originally
  // assumed strings, which silently worked while every code path that
  // hit the importer only ever had empty customLists. The first user
  // with a real custom list defined (e.g. one called "★") tripped a
  // SQLite bind failure because the object was being passed straight
  // through as the `name` column value.
  //
  // The fix:
  //   - extract `.name` from each `{name, enabled}` element
  //   - only record memberships where enabled === true (false means
  //     "the user has the list but this entry isn't in it" — promoting
  //     those would create false-positive chips on the detail panel)
  //
  // These tests pin both halves of the contract.
  // ────────────────────────────────────────────────────────────────────
  it('asArray:true shape — extracts .name from {name, enabled} objects and binds it as a string', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk(
        [
          makeEntry(1, {
            customLists: [
              { name: '★', enabled: true },
              { name: 'Top 2023', enabled: true },
            ],
          }),
        ],
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'custom_list')).toBe(2);
    expect(countRows(h.db, 'custom_list', `WHERE name = '★'`)).toBe(1);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Top 2023'`)).toBe(1);
    expect(
      countRows(
        h.db,
        'media_custom_list_membership',
        `WHERE custom_list_name = '★'`,
      ),
    ).toBe(1);
    h.db.close();
  });

  it('asArray:true shape — disabled entries do NOT become memberships, even when mixed with enabled ones', async () => {
    // The realistic shape AniList returns for a user with custom
    // lists defined: one entry per list, with `enabled` telling us
    // which lists THIS media is actually in. The user's reported bug
    // had `customLists: [{name: "★", enabled: false}]` for an entry
    // not in the ★ list — that must not produce a membership row.
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk(
        [
          // Entry 1: in 'Top 2023' only.
          makeEntry(1, {
            customLists: [
              { name: 'Top 2023', enabled: true },
              { name: '★', enabled: false },
              { name: 'Rewatch Queue', enabled: false },
            ],
          }),
          // Entry 2: in '★' only (user finally added something to it).
          makeEntry(2, {
            customLists: [
              { name: 'Top 2023', enabled: false },
              { name: '★', enabled: true },
              { name: 'Rewatch Queue', enabled: false },
            ],
          }),
          // Entry 3: in none of the user's lists. Disabled-only.
          makeEntry(3, {
            customLists: [
              { name: 'Top 2023', enabled: false },
              { name: '★', enabled: false },
              { name: 'Rewatch Queue', enabled: false },
            ],
          }),
        ],
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    // Two named lists actually have at least one member; the third
    // ('Rewatch Queue') is defined but empty → GC step (8) prunes it.
    expect(countRows(h.db, 'custom_list')).toBe(2);
    expect(countRows(h.db, 'custom_list', `WHERE name = 'Rewatch Queue'`)).toBe(0);
    // Exactly the enabled-true (entry, list) pairs become memberships.
    expect(countRows(h.db, 'media_custom_list_membership')).toBe(2);
    expect(
      countRows(
        h.db,
        'media_custom_list_membership',
        `WHERE media_id = 1 AND custom_list_name = 'Top 2023'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        h.db,
        'media_custom_list_membership',
        `WHERE media_id = 2 AND custom_list_name = '★'`,
      ),
    ).toBe(1);
    // Entry 3 contributes zero memberships and zero custom_list rows.
    expect(
      countRows(h.db, 'media_custom_list_membership', `WHERE media_id = 3`),
    ).toBe(0);
    h.db.close();
  });
});

describe('importAnilistList — wipe-and-rebuild semantics', () => {
  it('removes a list entry that no longer appears on AniList', async () => {
    // First import: user has anime 1 and 2 on their list.
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk([makeEntry(1), makeEntry(2)], { hasNextChunk: false }),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'media_list_entry')).toBe(2);

    // Second import: user removed anime 2 from their list. Without
    // wipe-and-rebuild the entry would linger; the wipe in step 2 of
    // buildListImportStatements drops it before reinsert.
    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListChunk([makeEntry(1)], { hasNextChunk: false }),
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
    h.enqueueListChunks(
      makeListChunk([makeEntry(1)], { hasNextChunk: false }),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 500')).toBe(1);
    expect(countRows(h.db, 'media_list_entry', 'WHERE media_id = 1')).toBe(1);
    h.db.close();
  });

  it('removes a studio/tag junction that no longer appears on AniList for a given media', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk(
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
        { hasNextChunk: false },
      ),
    );
    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(countRows(h.db, 'media_tag', "WHERE tag_name = 'Old'")).toBe(1);

    h.executeQuery.mockResolvedValueOnce(resolveResponse());
    h.executeQuery.mockResolvedValueOnce(
      makeListChunk(
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
        { hasNextChunk: false },
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

  // Regression: a media whose `studios.nodes` contains the same studio
  // twice (AniList edge-collapsing leak) used to blow the import with
  // `UNIQUE constraint failed: media_studio.media_id, media_studio.studio_id`.
  // The mapper now dedups within one media, so the import completes and
  // the junction holds exactly one row.
  it('survives AniList returning a duplicate studio in studios.nodes for one media', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk(
        [
          makeEntry(
            1,
            {},
            {
              studios: {
                nodes: [
                  { id: 10, name: 'Studio-X' },
                  { id: 10, name: 'Studio-X' }, // duplicate edge
                ],
              },
              tags: [
                { name: 'A', rank: 90 },
                { name: 'A', rank: 50 }, // duplicate tag
              ],
            },
          ),
        ],
        { hasNextChunk: false },
      ),
    );

    await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(countRows(h.db, 'media_studio', 'WHERE media_id = 1')).toBe(1);
    expect(countRows(h.db, 'media_tag', 'WHERE media_id = 1')).toBe(1);
    expect(
      h.db.selectValue(
        "SELECT rank FROM media_tag WHERE media_id = 1 AND tag_name = 'A'",
      ),
    ).toBe(90); // first wins — higher rank from the original edge
    h.db.close();
  });

  // Regression: `MediaListCollection.lists` returns the same entry once
  // per group it belongs to (one row in the "Completed" status group,
  // one row in every custom list it's in). The importer flattens all
  // groups and dedups by media.id — without that dedup an entry on two
  // lists would blow the PK on media_list_entry / media_studio / media_tag.
  it('dedups an entry that appears in multiple lists within one chunk (status + custom list)', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunkGroups(
        [
          {
            name: 'Completed',
            isCustomList: false,
            status: 'COMPLETED',
            entries: [makeEntry(1), makeEntry(2), makeEntry(3)],
          },
          // Entry 2 is ALSO in the user's "Top 10" custom list — comes
          // back as a second row in this group with identical media.id.
          {
            name: 'Top 10',
            isCustomList: true,
            status: null,
            entries: [makeEntry(2, { customLists: customLists('Top 10') })],
          },
        ],
        { hasNextChunk: false },
      ),
    );

    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });

    expect(result.entriesWritten).toBe(3);
    expect(countRows(h.db, 'media_list_entry')).toBe(3);
    expect(countRows(h.db, 'media_studio', 'WHERE media_id = 2')).toBe(1);
    expect(countRows(h.db, 'media_tag', 'WHERE media_id = 2')).toBe(1);
    h.db.close();
  });

  // Belt-and-braces: even though `MediaListCollection` chunks rarely
  // overlap (slicing happens in entry order, not by status), if
  // AniList ever returns the same entry on two chunks the importer
  // must still dedup. Covers `dedupEntriesByMediaId` running across
  // the chunk boundary, not just within a single chunk's groups.
  it('dedups across chunks too', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk([makeEntry(1), makeEntry(2)], { hasNextChunk: true }),
      makeListChunk([makeEntry(2), makeEntry(3)], { hasNextChunk: false }),
    );

    const result = await importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' });
    expect(result.chunksFetched).toBe(2);
    expect(result.entriesWritten).toBe(3);
    expect(countRows(h.db, 'media_list_entry')).toBe(3);
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
    h.enqueueListChunks(makeListChunk([], { hasNextChunk: false }));
    await expect(
      importAnilistList(h.ctx, { username: USER_NAME, type: 'ANIME' }),
    ).resolves.toMatchObject({ chunksFetched: 1 });
    h.db.close();
  });
});

describe('importAnilistList — mid-import failure leaves DB untouched', () => {
  it('a chunk-fetch error before the final commit means zero rows are written and no refresh stamp is set', async () => {
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
        makeListChunk([makeEntry(1)], { hasNextChunk: true }),
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

describe('importAnilistList — progress events', () => {
  it('fires resolving-user → per-chunk fetching-page → writing → done in order', async () => {
    const h = await makeHarness();
    h.enqueueListChunks(
      makeListChunk([makeEntry(1), makeEntry(2)], { hasNextChunk: true }),
      makeListChunk([makeEntry(3)], { hasNextChunk: false }),
    );

    const events: import('../progress').AnilistProgressEvent[] = [];
    await importAnilistList(
      { ...h.ctx, onProgress: (e) => events.push(e) },
      { username: USER_NAME, type: 'ANIME' },
    );

    // Ordering must be exact so the UI can drive a deterministic
    // label flip between stages. `itemsSoFar` is cumulative across
    // chunks so the UI can show "412 items so far" without holding
    // its own running total. The `page` slot on `fetching-page` doubles
    // as the chunk index here — the event kind/shape is shared with
    // the favourites and characters importers that still page.
    expect(events.map((e) => e.kind)).toEqual([
      'resolving-user',
      'fetching-page',
      'fetching-page',
      'writing',
      'done',
    ]);
    expect(events[0]).toMatchObject({
      kind: 'resolving-user',
      username: USER_NAME,
    });
    expect(events[1]).toMatchObject({
      kind: 'fetching-page',
      what: 'list',
      page: 1,
      itemsSoFar: 2,
    });
    expect(events[2]).toMatchObject({
      kind: 'fetching-page',
      what: 'list',
      page: 2,
      itemsSoFar: 3,
    });
    expect(events[3].kind).toBe('writing');
    expect((events[3] as { statements: number }).statements).toBeGreaterThan(0);
    h.db.close();
  });

  it('still fires resolving-user but no fetching/writing events when the user resolution fails', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce({ User: null });
    const events: import('../progress').AnilistProgressEvent[] = [];

    await expect(
      importAnilistList(
        { ...h.ctx, onProgress: (e) => events.push(e) },
        { username: 'no-such-user', type: 'ANIME' },
      ),
    ).rejects.toThrow();

    expect(events).toEqual([
      { kind: 'resolving-user', username: 'no-such-user' },
    ]);
    h.db.close();
  });
});
