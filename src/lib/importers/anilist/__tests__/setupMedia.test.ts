import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import {
  fetchAnimeById,
  pickRandomAnimeFromApi,
  searchAnimeFromApi,
} from '../setupMedia';
import type { AnilistMediaGql } from '../types';

type ExecCapable = { exec: (sql: string, opts?: { bind?: unknown }) => void };

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

function fullMedia(overrides: Partial<AnilistMediaGql> = {}): AnilistMediaGql {
  return {
    id: 1,
    type: 'ANIME',
    title: { english: 'One Piece', romaji: 'OP', native: null },
    coverImage: { large: 'https://example.test/cover.jpg' },
    format: 'TV',
    status: 'FINISHED',
    episodes: 1000,
    chapters: null,
    startDate: { year: 1999, month: 10, day: 20 },
    endDate: null,
    season: 'FALL',
    seasonYear: 1999,
    meanScore: 90,
    favourites: 100_000,
    countryOfOrigin: 'JP',
    genres: ['Action'],
    synonyms: null,
    studios: { nodes: [] },
    tags: [],
    ...overrides,
  };
}

describe('setupMedia', () => {
  let db: Database;
  let adapter: AnilistDbExecutor;
  let executeQuery: ReturnType<typeof vi.fn>;
  let ctx: AnilistImportContext;

  beforeEach(async () => {
    db = await openMemoryDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, anilistSourceDescriptor);
    adapter = makeDbAdapter(db);
    executeQuery = vi.fn();
    ctx = {
      executeQuery,
      db: adapter,
      now: () => 1_700_000_000_000,
    };
  });

  it('fetchAnimeById upserts and returns media row', async () => {
    executeQuery.mockResolvedValueOnce({ Media: fullMedia({ id: 21 }) });

    const row = await fetchAnimeById(ctx, 21);
    expect(row?.id).toBe(21);
    expect(row?.title_english).toBe('One Piece');

    const stored = await adapter.exec('SELECT id FROM media WHERE id = ?', [21]);
    expect(stored).toHaveLength(1);
  });

  it('searchAnimeFromApi upserts each result', async () => {
    executeQuery.mockResolvedValueOnce({
      Page: { pageInfo: { hasNextPage: false, currentPage: 1 }, media: [fullMedia({ id: 22 })] },
    });

    const rows = await searchAnimeFromApi(ctx, 'piece', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(22);
  });

  it('pickRandomAnimeFromApi chooses from a browse page', async () => {
    executeQuery
      .mockResolvedValueOnce({
        Page: { pageInfo: { total: 100 }, media: [{ id: 1 }] },
      })
      .mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: false, currentPage: 1 },
          media: [fullMedia({ id: 33 }), fullMedia({ id: 34 })],
        },
      });

    const row = await pickRandomAnimeFromApi(ctx);
    expect(row).not.toBeNull();
    expect([33, 34]).toContain(row?.id);
  });
});
