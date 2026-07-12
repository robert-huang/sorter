import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import {
  expandMediaCastBatch,
  expandMediaCastWithFallback,
} from '../expandMediaCastBatch';
import type {
  AnilistCharacterGql,
  AnilistMediaCharacterEdgeGql,
  AnilistMediaStaffEdgeGql,
  AnilistStaffGql,
} from '../types';

// ── DB adapter (same shape as lazyExpansion.test.ts) ──

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

function makeCharacter(id: number): AnilistCharacterGql {
  return {
    id,
    name: { full: `Char-${id}`, native: null, alternative: null, alternativeSpoiler: null },
    image: { large: `https://example.test/c${id}.jpg` },
    age: '17',
    gender: null,
    favourites: 100,
  };
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

function makeCharEdge(characterId: number, vaIds: number[] = []): AnilistMediaCharacterEdgeGql {
  return {
    role: 'MAIN',
    node: makeCharacter(characterId),
    voiceActors: vaIds.map((id) => makeStaff(id)),
  };
}

function makeStaffEdge(staffId: number): AnilistMediaStaffEdgeGql {
  return { role: 'Director', node: makeStaff(staffId) };
}

type MediaPlan = {
  exists?: boolean;
  charPages?: AnilistMediaCharacterEdgeGql[][];
  staffPages?: AnilistMediaStaffEdgeGql[][];
};

/**
 * Aliased-batch mock: reads `id{i}` + `charactersPage{i}`/`staffPage{i}` from
 * the variables and returns `m{i}` with the requested page's edges. Records
 * every batched request so tests can assert cursors advanced in one round-trip.
 */
function makeBatchMock(plan: Map<number, MediaPlan>) {
  const charBatchCalls: Array<Array<{ id: number; page: number }>> = [];
  const staffBatchCalls: Array<Array<{ id: number; page: number }>> = [];

  const fn = vi.fn(async (query: string, variablesRaw: Record<string, unknown>) => {
    const variables = variablesRaw as Record<string, number>;
    if (query.includes('ToolsMediaCharactersBatch')) {
      const requestGroup: Array<{ id: number; page: number }> = [];
      const out: Record<string, unknown> = {};
      let i = 0;
      while (variables[`id${i}`] !== undefined) {
        const id = variables[`id${i}`]!;
        const page = variables[`charactersPage${i}`]!;
        requestGroup.push({ id, page });
        const p = plan.get(id);
        if (!p || p.exists === false) {
          out[`m${i}`] = null;
        } else {
          const pages = p.charPages ?? [];
          out[`m${i}`] = {
            id,
            characters: {
              pageInfo: { hasNextPage: page < pages.length, currentPage: page },
              edges: pages[page - 1] ?? [],
            },
          };
        }
        i += 1;
      }
      charBatchCalls.push(requestGroup);
      return out;
    }
    if (query.includes('ToolsMediaStaffBatch')) {
      const requestGroup: Array<{ id: number; page: number }> = [];
      const out: Record<string, unknown> = {};
      let i = 0;
      while (variables[`id${i}`] !== undefined) {
        const id = variables[`id${i}`]!;
        const page = variables[`staffPage${i}`]!;
        requestGroup.push({ id, page });
        const p = plan.get(id);
        if (!p || p.exists === false) {
          out[`m${i}`] = null;
        } else {
          const pages = p.staffPages ?? [];
          out[`m${i}`] = {
            id,
            staff: {
              pageInfo: { hasNextPage: page < pages.length, currentPage: page },
              edges: pages[page - 1] ?? [],
            },
          };
        }
        i += 1;
      }
      staffBatchCalls.push(requestGroup);
      return out;
    }
    return null;
  });

  return { fn, charBatchCalls, staffBatchCalls };
}

type Harness = {
  db: Database;
  ctx: AnilistImportContext;
  dirty: ReturnType<typeof vi.fn>;
};

async function makeHarness(
  seedMediaIds: number[],
  executeQuery: unknown,
): Promise<Harness> {
  const db = await freshAnilistDb();
  for (const id of seedMediaIds) {
    db.exec('INSERT INTO media (id, type, fetched_at, updated_at) VALUES (?, ?, ?, ?)', {
      bind: [id, 'ANIME', NOW, NOW],
    });
  }
  const dirty = vi.fn();
  const ctx: AnilistImportContext = {
    executeQuery: executeQuery as AnilistImportContext['executeQuery'],
    db: makeDbAdapter(db),
    now: () => NOW,
    onDirtyIncrement: dirty,
  };
  return { db, ctx, dirty };
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

describe('expandMediaCastBatch — batching invariant', () => {
  it('advances both media character cursors in a single round-trip per page', async () => {
    const plan = new Map<number, MediaPlan>([
      [100, { charPages: [[makeCharEdge(1000, [9001])], [makeCharEdge(1001)]], staffPages: [[makeStaffEdge(9100)]] }],
      [200, { charPages: [[makeCharEdge(2000, [9002])], [makeCharEdge(2001)]], staffPages: [[makeStaffEdge(9200)]] }],
    ]);
    const mock = makeBatchMock(plan);
    const h = await makeHarness([100, 200], mock.fn);

    await expandMediaCastBatch(
      h.ctx,
      [
        { mediaId: 100, scope: 'all' },
        { mediaId: 200, scope: 'all' },
      ],
    );

    // Character pagination: 2 pages, each a single batched call carrying BOTH ids.
    expect(mock.charBatchCalls).toHaveLength(2);
    expect(mock.charBatchCalls[0]).toEqual([
      { id: 100, page: 1 },
      { id: 200, page: 1 },
    ]);
    expect(mock.charBatchCalls[1]).toEqual([
      { id: 100, page: 2 },
      { id: 200, page: 2 },
    ]);
    // Staff: 1 page, one batched call for both.
    expect(mock.staffBatchCalls).toHaveLength(1);
    expect(mock.staffBatchCalls[0]).toEqual([
      { id: 100, page: 1 },
      { id: 200, page: 1 },
    ]);

    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(2);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 200')).toBe(2);
    expect(countRows(h.db, 'media_staff', 'WHERE media_id = 100')).toBe(1);
    expect(countRows(h.db, 'media_staff', 'WHERE media_id = 200')).toBe(1);
    expect(countRows(h.db, 'media_cast_expansion')).toBe(2);

    const markers = h.db.selectObjects(
      'SELECT media_id, characters_complete, staff_complete FROM media_cast_expansion ORDER BY media_id',
    );
    expect(markers).toEqual([
      { media_id: 100, characters_complete: 1, staff_complete: 1 },
      { media_id: 200, characters_complete: 1, staff_complete: 1 },
    ]);
    h.db.close();
  });

  it('stops paginating a media that finished while another keeps going', async () => {
    const plan = new Map<number, MediaPlan>([
      [100, { charPages: [[makeCharEdge(1000)]], staffPages: [] }],
      [200, { charPages: [[makeCharEdge(2000)], [makeCharEdge(2001)]], staffPages: [] }],
    ]);
    const mock = makeBatchMock(plan);
    const h = await makeHarness([100, 200], mock.fn);

    await expandMediaCastBatch(h.ctx, [
      { mediaId: 100, scope: 'characters' },
      { mediaId: 200, scope: 'characters' },
    ]);

    // Page 1: both ids. Page 2: only 200 (100 finished on page 1).
    expect(mock.charBatchCalls[0]).toEqual([
      { id: 100, page: 1 },
      { id: 200, page: 1 },
    ]);
    expect(mock.charBatchCalls[1]).toEqual([{ id: 200, page: 2 }]);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 200')).toBe(2);
    h.db.close();
  });
});

describe('expandMediaCastBatch — missing media', () => {
  it('skips a media whose cast query returns null (no rows, no marker)', async () => {
    const plan = new Map<number, MediaPlan>([
      [100, { charPages: [[makeCharEdge(1000)]], staffPages: [[makeStaffEdge(9100)]] }],
      [200, { exists: false }],
    ]);
    const mock = makeBatchMock(plan);
    const h = await makeHarness([100, 200], mock.fn);

    await expandMediaCastBatch(h.ctx, [
      { mediaId: 100, scope: 'all' },
      { mediaId: 200, scope: 'all' },
    ]);

    expect(countRows(h.db, 'media_cast_expansion', 'WHERE media_id = 100')).toBe(1);
    expect(countRows(h.db, 'media_cast_expansion', 'WHERE media_id = 200')).toBe(0);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 200')).toBe(0);
    h.db.close();
  });
});

describe('expandMediaCastBatch — scope', () => {
  it('scope=staff never issues a characters query and leaves media_character untouched', async () => {
    const plan = new Map<number, MediaPlan>([
      [100, { charPages: [[makeCharEdge(1000)]], staffPages: [[makeStaffEdge(9100), makeStaffEdge(9101)]] }],
    ]);
    const mock = makeBatchMock(plan);
    const h = await makeHarness([100], mock.fn);

    await expandMediaCastBatch(h.ctx, [{ mediaId: 100, scope: 'staff' }]);

    expect(mock.charBatchCalls).toHaveLength(0);
    expect(mock.staffBatchCalls).toHaveLength(1);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(0);
    expect(countRows(h.db, 'media_staff', 'WHERE media_id = 100')).toBe(2);
    const marker = h.db.selectObject(
      'SELECT characters_complete, staff_complete FROM media_cast_expansion WHERE media_id = 100',
    );
    expect(marker).toEqual({ characters_complete: 0, staff_complete: 1 });
    h.db.close();
  });
});

describe('expandMediaCastBatch — dedupe', () => {
  it('collapses duplicate media ids so a cursor is never advanced twice', async () => {
    const plan = new Map<number, MediaPlan>([
      [100, { charPages: [[makeCharEdge(1000)]], staffPages: [[makeStaffEdge(9100)]] }],
    ]);
    const mock = makeBatchMock(plan);
    const h = await makeHarness([100], mock.fn);

    await expandMediaCastBatch(h.ctx, [
      { mediaId: 100, scope: 'all' },
      { mediaId: 100, scope: 'all' },
    ]);

    expect(mock.charBatchCalls[0]).toEqual([{ id: 100, page: 1 }]);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(1);
    h.db.close();
  });
});

describe('expandMediaCastWithFallback', () => {
  it('falls back to per-media single expansion when the batch throws', async () => {
    const singleCalls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const executeQuery = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('Batch')) {
        throw new Error('batch transport failure');
      }
      singleCalls.push({ query, variables });
      // Single-entity MediaDetail / MediaStaffOnly shapes.
      if (query.includes('MediaDetail')) {
        return {
          Media: {
            id: variables.id,
            characters: {
              pageInfo: { hasNextPage: false, currentPage: 1 },
              edges: [makeCharEdge(1000, [9001])],
            },
            staff: { pageInfo: { hasNextPage: false, currentPage: 1 }, edges: [] },
          },
        } as never;
      }
      if (query.includes('MediaStaffOnly')) {
        return {
          Media: {
            id: variables.id,
            staff: {
              pageInfo: { hasNextPage: false, currentPage: 1 },
              edges: [makeStaffEdge(9100)],
            },
          },
        } as never;
      }
      return null;
    });
    const h = await makeHarness([100], executeQuery);

    await expandMediaCastWithFallback(h.ctx, [{ mediaId: 100, scope: 'all' }]);

    // Batch attempted first (threw), then single-entity path persisted.
    expect(singleCalls.some((c) => c.query.includes('MediaDetail'))).toBe(true);
    expect(countRows(h.db, 'media_character', 'WHERE media_id = 100')).toBe(1);
    expect(countRows(h.db, 'media_cast_expansion', 'WHERE media_id = 100')).toBe(1);
    h.db.close();
  });
});
