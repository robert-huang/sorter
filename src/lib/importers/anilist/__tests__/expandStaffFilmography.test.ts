import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import { expandStaffFilmography } from '../expandStaffFilmography';
import type { AnilistStaffFilmographyResponse } from '../types';

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
const VA_STAFF_ID = 96001;
const CHARACTER_ID = 89001;

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

function makeFilmographyResponse(): AnilistStaffFilmographyResponse {
  return {
    Staff: {
      id: VA_STAFF_ID,
      name: { full: 'Test VA', native: null },
      languageV2: null,
      image: { large: null },
      age: null,
      gender: 'Female',
      favourites: null,
      characterMedia: {
        pageInfo: { hasNextPage: false, currentPage: 1 },
        edges: [
          {
            characterRole: 'MAIN',
            characters: [
              {
                id: CHARACTER_ID,
                name: {
                  full: 'Fav Char',
                  native: null,
                  alternative: null,
                  alternativeSpoiler: null,
                },
                image: { large: null },
                age: null,
                gender: null,
                favourites: null,
              },
            ],
            node: {
              id: 1001,
              title: { romaji: 'Test Anime', native: null, english: null },
              type: 'ANIME',
              format: 'TV',
              coverImage: { large: 'https://example.test/cover.jpg' },
            } as never,
          },
        ],
      },
      staffMedia: {
        pageInfo: { hasNextPage: false, currentPage: 1 },
        edges: [],
      },
    },
  };
}

describe('expandStaffFilmography', () => {
  beforeEach(() => {
    _clearDbSyncManifestForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wipe existing character gender when filmography nodes omit profile fields', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeFilmographyResponse());
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    db.exec(
      `INSERT INTO staff (
         id, name_full, name_native, image, age, gender, language_v2, favourites, fetched_at, updated_at
       ) VALUES (?, 'Test VA', NULL, NULL, NULL, 'Female', NULL, NULL, ?, ?)`,
      { bind: [VA_STAFF_ID, NOW, NOW] },
    );
    db.exec(
      `INSERT INTO character (
         id, name_full, name_native, name_alternatives_json, name_alternatives_spoiler_json,
         image, age, gender, favourites, birth_year, birth_month, birth_day, fetched_at, updated_at
       ) VALUES (?, 'Fav Char', NULL, '[]', '[]', NULL, '17', 'Female', NULL, NULL, NULL, NULL, ?, ?)`,
      { bind: [CHARACTER_ID, NOW, NOW] },
    );

    const result = await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(result).toMatchObject({
      staffId: VA_STAFF_ID,
      cvaWritten: 1,
    });

    const row = db.selectObject('SELECT gender FROM character WHERE id = ?', CHARACTER_ID);
    expect(row).toEqual({ gender: 'Female' });
    db.close();
  });
});
