import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import { expandAnilistMediaDetail } from '../lazyExpansion';
import type {
  AnilistCharacterGql,
  AnilistMediaCharacterEdgeGql,
  AnilistMediaDetailResponse,
  AnilistMediaStaffEdgeGql,
  AnilistStaffGql,
} from '../types';

// ── DB adapter (same shape as importer.test.ts) ──

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

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

function makeCharacter(id: number, overrides: Partial<AnilistCharacterGql> = {}): AnilistCharacterGql {
  return {
    id,
    name: { full: `Char-${id}`, native: null, alternative: null, alternativeSpoiler: null },
    image: { large: `https://example.test/c${id}.jpg` },
    age: '17',
    gender: null,
    favourites: 100,
    ...overrides,
  };
}

function makeStaff(id: number, overrides: Partial<AnilistStaffGql> = {}): AnilistStaffGql {
  return {
    id,
    name: { full: `Staff-${id}`, native: null },
    languageV2: null,
    image: { large: null },
    age: null,
    gender: null,
    favourites: 50,
    ...overrides,
  };
}

function makeCharEdge(
  characterId: number,
  voiceActorIds: number[] = [],
): AnilistMediaCharacterEdgeGql {
  return {
    role: 'MAIN',
    node: makeCharacter(characterId),
    voiceActors: voiceActorIds.map((id) => makeStaff(id)),
  };
}

function makeStaffEdge(staffId: number): AnilistMediaStaffEdgeGql {
  return { role: 'Director', node: makeStaff(staffId) };
}

function makeDetailResponse(
  charactersEdges: AnilistMediaCharacterEdgeGql[],
  staffEdges: AnilistMediaStaffEdgeGql[],
  charactersHasNext: boolean,
  mediaId = 100,
): AnilistMediaDetailResponse {
  return {
    Media: {
      id: mediaId,
      characters: {
        pageInfo: { hasNextPage: charactersHasNext, currentPage: 1 },
        edges: charactersEdges,
      },
      staff: {
        pageInfo: { hasNextPage: false, currentPage: 1 },
        edges: staffEdges,
      },
    },
  };
}

type Harness = {
  db: Database;
  ctx: AnilistImportContext;
  executeQuery: ReturnType<typeof vi.fn>;
  dirty: ReturnType<typeof vi.fn>;
  autoPush: ReturnType<typeof vi.fn>;
};

async function makeHarness(): Promise<Harness> {
  const db = await freshAnilistDb();
  // Pre-seed the media row that lazy expansion expects to exist already.
  db.exec(
    'INSERT INTO media (id, type, fetched_at, updated_at) VALUES (?, ?, ?, ?)',
    { bind: [100, 'ANIME', NOW, NOW] },
  );
  const executeQuery = vi.fn();
  const dirty = vi.fn();
  const autoPush = vi.fn();
  const ctx: AnilistImportContext = {
    executeQuery,
    db: makeDbAdapter(db),
    now: () => NOW,
    onAutoPushRequested: autoPush,
    onDirtyIncrement: dirty,
  };
  return { db, ctx, executeQuery, dirty, autoPush };
}

function countRows(db: Database, table: string, where = ''): number {
  const value = db.selectValue(`SELECT COUNT(*) FROM ${table} ${where}`);
  return typeof value === 'number' ? value : Number(value);
}

beforeEach(() => {
  _clearDbSyncManifestForTesting();
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
});

describe('expandAnilistMediaDetail — happy path', () => {
  it('rebuilds media_character + character_voice_actor (JP) and upserts character/staff metadata', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce(
      makeDetailResponse(
        [
          makeCharEdge(1000, [9001, 9002]),
          makeCharEdge(1001, [9001]),
          makeCharEdge(1002, []),
        ],
        [makeStaffEdge(9100), makeStaffEdge(9101)],
        false,
      ),
    );

    const result = await expandAnilistMediaDetail(h.ctx, 100);

    expect(result).toEqual({
      mediaId: 100,
      characterPagesFetched: 1,
      charactersWritten: 3,
      staffWritten: 4, // 9001, 9002, 9100, 9101 (dedup)
      voiceActorsWritten: 3,
    });
    expect(countRows(h.db, 'character')).toBe(3);
    expect(countRows(h.db, 'staff')).toBe(4);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(3);
    expect(countRows(h.db, 'character_voice_actor', 'WHERE media_id = 100')).toBe(3);

    const langs = h.db.selectObjects(
      'SELECT DISTINCT language FROM character_voice_actor',
    );
    expect(langs).toEqual([{ language: 'JAPANESE' }]);

    // Single source of truth: the same language that's written to the DB
    // must be the one sent in the GraphQL `voiceActors(language: …)` filter.
    const sentQuery = h.executeQuery.mock.calls[0][0] as string;
    expect(sentQuery).toContain('voiceActors(language: JAPANESE)');

    expect(h.dirty).toHaveBeenCalledTimes(1);
    // Lazy expansion must NOT trigger autopush (Phase D manual-push only)
    expect(h.autoPush).not.toHaveBeenCalled();
    h.db.close();
  });
});

describe('expandAnilistMediaDetail — pagination cap', () => {
  it('fetches at most charactersMaxPages (default 2) character pages', async () => {
    const h = await makeHarness();
    h.executeQuery
      .mockResolvedValueOnce(
        makeDetailResponse([makeCharEdge(1, [9001])], [makeStaffEdge(9100)], true),
      )
      .mockResolvedValueOnce(
        makeDetailResponse([makeCharEdge(2, [9002])], [makeStaffEdge(9100)], true),
      );
    const result = await expandAnilistMediaDetail(h.ctx, 100);

    expect(result?.characterPagesFetched).toBe(2);
    // Only 2 HTTP calls — third page was within hasNextPage but cap hit
    expect(h.executeQuery).toHaveBeenCalledTimes(2);
    expect(result?.charactersWritten).toBe(2);
    h.db.close();
  });

  it('stops early when hasNextPage is false even if the cap allows more', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce(
      makeDetailResponse([makeCharEdge(1)], [makeStaffEdge(9100)], false),
    );
    const result = await expandAnilistMediaDetail(h.ctx, 100, { charactersMaxPages: 5 });
    expect(result?.characterPagesFetched).toBe(1);
    expect(h.executeQuery).toHaveBeenCalledTimes(1);
    h.db.close();
  });
});

describe('expandAnilistMediaDetail — rebuild semantics', () => {
  it('cascades character_voice_actor cleanup when a character is dropped on refresh', async () => {
    const h = await makeHarness();
    // First call: media 100 has 2 characters with VAs
    h.executeQuery.mockResolvedValueOnce(
      makeDetailResponse(
        [makeCharEdge(1000, [9001]), makeCharEdge(1001, [9002])],
        [],
        false,
      ),
    );
    await expandAnilistMediaDetail(h.ctx, 100);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(2);
    expect(countRows(h.db, 'character_voice_actor', 'WHERE media_id = 100')).toBe(2);

    // Second call: media 100 now has 1 character with 1 VA
    h.executeQuery.mockResolvedValueOnce(
      makeDetailResponse([makeCharEdge(1000, [9001])], [], false),
    );
    await expandAnilistMediaDetail(h.ctx, 100);

    // CVA for character 1001 cascaded away via the (media_id, character_id) FK
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(1);
    expect(countRows(h.db, 'character_voice_actor', 'WHERE media_id = 100')).toBe(1);
    // Parent character / staff rows persist (no upward cascade)
    expect(countRows(h.db, 'character')).toBe(2);
    expect(countRows(h.db, 'staff')).toBe(2);
    h.db.close();
  });
});

describe('expandAnilistMediaDetail — 404', () => {
  it('returns null and does not touch the DB when Media(id:) is missing', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce(null);
    const result = await expandAnilistMediaDetail(h.ctx, 999_999);
    expect(result).toBeNull();
    expect(h.dirty).not.toHaveBeenCalled();
    expect(countRows(h.db, 'media_character')).toBe(0);
    h.db.close();
  });

  it('returns null when AniList returns a response with Media: null', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce({ Media: null });
    const result = await expandAnilistMediaDetail(h.ctx, 999_999);
    expect(result).toBeNull();
    h.db.close();
  });
});

describe('expandAnilistMediaDetail — voiceActorLanguage single source of truth', () => {
  it('threads the configured language into BOTH the GraphQL filter and the DB row', async () => {
    const h = await makeHarness();
    h.executeQuery.mockResolvedValueOnce(
      makeDetailResponse(
        [makeCharEdge(1000, [9001]), makeCharEdge(1001, [9002])],
        [],
        false,
      ),
    );
    await expandAnilistMediaDetail(h.ctx, 100, { voiceActorLanguage: 'ENGLISH' });

    // (1) DB-side: every CVA row carries the configured language.
    const rows = h.db.selectObjects(
      'SELECT DISTINCT language FROM character_voice_actor',
    );
    expect(rows).toEqual([{ language: 'ENGLISH' }]);

    // (2) Wire-side: the GraphQL filter sent to AniList matches. Without
    // this assertion, swapping JAPANESE → ENGLISH on the DB write while
    // still sending `voiceActors(language: JAPANESE)` to the server would
    // silently mislabel JP VAs as ENGLISH.
    const sentQuery = h.executeQuery.mock.calls[0][0] as string;
    expect(sentQuery).toContain('voiceActors(language: ENGLISH)');
    expect(sentQuery).not.toContain('voiceActors(language: JAPANESE)');

    h.db.close();
  });
});

describe('expandAnilistMediaDetail — progress events', () => {
  it('fires fetching-page (characters) → writing → done in order', async () => {
    const h = await makeHarness();
    h.executeQuery
      .mockResolvedValueOnce(
        makeDetailResponse([makeCharEdge(1, [9001])], [makeStaffEdge(9100)], true),
      )
      .mockResolvedValueOnce(
        makeDetailResponse([makeCharEdge(2, [9002])], [], false),
      );

    const events: import('../progress').AnilistProgressEvent[] = [];
    await expandAnilistMediaDetail(
      { ...h.ctx, onProgress: (e) => events.push(e) },
      100,
    );

    expect(events.map((e) => e.kind)).toEqual([
      'fetching-page',
      'fetching-page',
      'writing',
      'done',
    ]);
    expect(events[0]).toMatchObject({
      kind: 'fetching-page',
      what: 'characters',
      page: 1,
      itemsSoFar: 1,
    });
    expect(events[1]).toMatchObject({
      kind: 'fetching-page',
      what: 'characters',
      page: 2,
      itemsSoFar: 2,
    });
    h.db.close();
  });
});
