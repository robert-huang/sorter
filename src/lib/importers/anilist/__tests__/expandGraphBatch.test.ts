import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import {
  expandCharacterMediaBatch,
  expandStaffFilmographyBatch,
} from '../expandGraphBatch';
import type {
  AnilistCharacterMediaEdgeGql,
  AnilistMediaGql,
  AnilistStaffCharacterMediaEdgeGql,
  AnilistStaffGql,
  AnilistStaffMediaEdgeGql,
} from '../types';

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

function makeStaff(id: number): AnilistStaffGql {
  return {
    id,
    name: { full: `Staff-${id}`, native: null },
    languageV2: null,
    image: { large: null },
    age: null,
    gender: null,
    favourites: 50,
  };
}

function makeMedia(id: number): AnilistMediaGql {
  return {
    id,
    type: 'ANIME',
    title: { english: `Show-${id}`, romaji: `Show-${id}`, native: null },
    coverImage: { large: null },
    format: 'TV',
    source: 'ORIGINAL',
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    startDate: null,
    endDate: null,
    season: null,
    seasonYear: null,
    meanScore: null,
    favourites: null,
    countryOfOrigin: 'JP',
    genres: null,
    synonyms: null,
    studios: { nodes: [] },
    tags: [],
  } as unknown as AnilistMediaGql;
}

function makeCharacterMediaEdge(mediaId: number, vaIds: number[] = []): AnilistCharacterMediaEdgeGql {
  return {
    characterRole: 'MAIN',
    node: makeMedia(mediaId),
    voiceActors: vaIds.map((id) => makeStaff(id)),
  };
}

function makeStaffCharMediaEdge(
  mediaId: number,
  characterId: number,
): AnilistStaffCharacterMediaEdgeGql {
  return {
    characterRole: 'MAIN',
    characters: [
      {
        id: characterId,
        name: { full: `Char-${characterId}`, native: null, alternative: null, alternativeSpoiler: null },
        image: { large: null },
        age: null,
        gender: null,
        favourites: 10,
      },
    ],
    node: makeMedia(mediaId),
  };
}

function makeStaffMediaEdge(mediaId: number): AnilistStaffMediaEdgeGql {
  return { staffRole: 'Director', node: makeMedia(mediaId) };
}

function makeCtx(db: Database): { ctx: AnilistImportContext; dirty: ReturnType<typeof vi.fn>; executeQuery: ReturnType<typeof vi.fn> } {
  const dirty = vi.fn();
  const executeQuery = vi.fn();
  const ctx: AnilistImportContext = {
    executeQuery,
    db: makeDbAdapter(db),
    now: () => NOW,
    onDirtyIncrement: dirty,
  };
  return { ctx, dirty, executeQuery };
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

describe('expandCharacterMediaBatch', () => {
  it('advances both character cursors per page in a single round-trip', async () => {
    const db = await freshAnilistDb();
    // The subject character rows are seeded by Favourites before expansion;
    // media_character FKs to them.
    for (const id of [10, 20]) {
      db.exec('INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)', {
        bind: [id, `Char-${id}`, NOW, NOW],
      });
    }
    const { ctx, executeQuery } = makeCtx(db);

    const charBatchCalls: Array<Array<{ id: number; page: number }>> = [];
    const plan = new Map<number, AnilistCharacterMediaEdgeGql[][]>([
      [10, [[makeCharacterMediaEdge(100, [9001])], [makeCharacterMediaEdge(101)]]],
      [20, [[makeCharacterMediaEdge(200)], [makeCharacterMediaEdge(201)]]],
    ]);
    executeQuery.mockImplementation(async (query: string, variables: Record<string, number>) => {
      expect(query).toContain('ToolsCharacterVoiceMediaBatch');
      const group: Array<{ id: number; page: number }> = [];
      const out: Record<string, unknown> = {};
      let i = 0;
      while (variables[`id${i}`] !== undefined) {
        const id = variables[`id${i}`]!;
        const page = variables[`page${i}`]!;
        group.push({ id, page });
        const pages = plan.get(id) ?? [];
        out[`c${i}`] = {
          id,
          media: {
            pageInfo: { hasNextPage: page < pages.length, currentPage: page },
            edges: pages[page - 1] ?? [],
          },
        };
        i += 1;
      }
      charBatchCalls.push(group);
      return out;
    });

    await expandCharacterMediaBatch(ctx, [10, 20]);

    expect(charBatchCalls).toHaveLength(2);
    expect(charBatchCalls[0]).toEqual([
      { id: 10, page: 1 },
      { id: 20, page: 1 },
    ]);
    expect(charBatchCalls[1]).toEqual([
      { id: 10, page: 2 },
      { id: 20, page: 2 },
    ]);
    expect(countRows(db, 'media_character', 'WHERE character_id = 10')).toBe(2);
    expect(countRows(db, 'media_character', 'WHERE character_id = 20')).toBe(2);
    expect(countRows(db, 'character_media_expansion')).toBe(2);
    db.close();
  });

  it('skips a character whose media query returns null Character', async () => {
    const db = await freshAnilistDb();
    for (const id of [10, 20]) {
      db.exec('INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (?, ?, ?, ?)', {
        bind: [id, `Char-${id}`, NOW, NOW],
      });
    }
    const { ctx, executeQuery } = makeCtx(db);
    executeQuery.mockImplementation(async (_query: string, variables: Record<string, number>) => {
      const out: Record<string, unknown> = {};
      let i = 0;
      while (variables[`id${i}`] !== undefined) {
        const id = variables[`id${i}`]!;
        out[`c${i}`] = id === 10 ? { id, media: { pageInfo: { hasNextPage: false, currentPage: 1 }, edges: [makeCharacterMediaEdge(100)] } } : null;
        i += 1;
      }
      return out;
    });

    await expandCharacterMediaBatch(ctx, [10, 20]);

    expect(countRows(db, 'character_media_expansion', 'WHERE character_id = 10')).toBe(1);
    expect(countRows(db, 'character_media_expansion', 'WHERE character_id = 20')).toBe(0);
    db.close();
  });
});

describe('expandStaffFilmographyBatch', () => {
  it('issues one characterMedia batch and one staffMedia batch carrying all ids', async () => {
    const db = await freshAnilistDb();
    const { ctx, executeQuery } = makeCtx(db);

    let charBatchCalls = 0;
    let staffMediaBatchCalls = 0;
    executeQuery.mockImplementation(async (query: string, variables: Record<string, number>) => {
      const out: Record<string, unknown> = {};
      let i = 0;
      if (query.includes('ToolsStaffFilmographyCharacterBatch')) {
        charBatchCalls += 1;
        while (variables[`id${i}`] !== undefined) {
          const id = variables[`id${i}`]!;
          const page = variables[`charactersPage${i}`]!;
          out[`s${i}`] = {
            ...makeStaff(id),
            characterMedia: {
              pageInfo: { hasNextPage: false, currentPage: page },
              edges: [makeStaffCharMediaEdge(300 + id, 400 + id)],
            },
            staffMedia: null,
          };
          i += 1;
        }
        return out;
      }
      if (query.includes('ToolsStaffFilmographyStaffMediaBatch')) {
        staffMediaBatchCalls += 1;
        while (variables[`id${i}`] !== undefined) {
          const id = variables[`id${i}`]!;
          const page = variables[`staffMediaPage${i}`]!;
          out[`s${i}`] = {
            ...makeStaff(id),
            characterMedia: null,
            staffMedia: {
              pageInfo: { hasNextPage: false, currentPage: page },
              edges: [makeStaffMediaEdge(500 + id)],
            },
          };
          i += 1;
        }
        return out;
      }
      return null;
    });

    await expandStaffFilmographyBatch(ctx, [1, 2]);

    expect(charBatchCalls).toBe(1);
    expect(staffMediaBatchCalls).toBe(1);
    expect(countRows(db, 'staff_filmography_expansion')).toBe(2);
    // media_staff credits from staffMedia edges (one per staff)
    expect(countRows(db, 'media_staff', 'WHERE staff_id = 1')).toBe(1);
    expect(countRows(db, 'media_staff', 'WHERE staff_id = 2')).toBe(1);
    db.close();
  });
});
