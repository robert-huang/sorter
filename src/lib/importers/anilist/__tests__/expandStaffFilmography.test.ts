import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import { expandStaffFilmography } from '../expandStaffFilmography';
import type {
  AnilistMediaGql,
  AnilistStaffFilmographyResponse,
  AnilistStaffGql,
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
const VA_STAFF_ID = 96001;
const CHARACTER_ID = 89001;

function fullMedia(overrides: Partial<AnilistMediaGql> = {}): AnilistMediaGql {
  return {
    id: 1002,
    type: 'ANIME',
    title: { romaji: 'Production Anime', native: null, english: null },
    coverImage: { large: 'https://example.test/production.jpg' },
    format: 'TV',
    source: 'ORIGINAL',
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    startDate: { year: 2025, month: 1, day: 1 },
    endDate: null,
    season: 'WINTER',
    seasonYear: 2025,
    meanScore: 80,
    favourites: 100,
    countryOfOrigin: 'JP',
    genres: ['Drama'],
    synonyms: [],
    studios: { edges: [] },
    tags: [],
    ...overrides,
  };
}

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

function makeFilmographyResponse(
  staffOverrides: Partial<AnilistStaffGql> = {},
): AnilistStaffFilmographyResponse {
  return {
    Staff: {
      id: VA_STAFF_ID,
      name: { full: 'Test VA', native: null },
      languageV2: null,
      image: { large: null },
      age: null,
      gender: 'Female',
      favourites: null,
      ...staffOverrides,
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
              startDate: { year: 2026, month: null, day: null },
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

  it('advances both connections together without restarting at page one', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockImplementation(
      async (_query: string, variables: Record<string, unknown>) => {
        const charactersPage = Number(variables.charactersPage);
        const response = makeFilmographyResponse();
        if (response.Staff?.characterMedia) {
          response.Staff.characterMedia.pageInfo = {
            hasNextPage: charactersPage < 3,
            currentPage: charactersPage,
          };
          if (charactersPage > 1) {
            response.Staff.characterMedia.edges = [];
          }
        }
        return response;
      },
    );
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    const result = await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(result).toMatchObject({
      characterPagesFetched: 3,
      staffMediaPagesFetched: 1,
    });
    expect(
      executeQuery.mock.calls.map(([, variables]) => ({
        charactersPage: variables.charactersPage,
        staffMediaPage: variables.staffMediaPage,
        includeCharacters: variables.includeCharacters,
        includeStaffMedia: variables.includeStaffMedia,
      })),
    ).toEqual([
      {
        charactersPage: 1,
        staffMediaPage: 1,
        includeCharacters: true,
        includeStaffMedia: true,
      },
      {
        charactersPage: 2,
        staffMediaPage: 1,
        includeCharacters: true,
        includeStaffMedia: false,
      },
      {
        charactersPage: 3,
        staffMediaPage: 1,
        includeCharacters: true,
        includeStaffMedia: false,
      },
    ]);
    db.close();
  });

  it('does not probe page one again for a valid empty filmography', async () => {
    const db = await freshAnilistDb();
    const response = makeFilmographyResponse();
    response.Staff!.characterMedia!.edges = [];
    const executeQuery = vi.fn().mockResolvedValue(response);
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    const result = await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(result).not.toBeNull();
    expect(executeQuery).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('does not retry page one when the requested staff does not exist', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue({ Staff: null });
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    const result = await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(result).toBeNull();
    expect(executeQuery).toHaveBeenCalledTimes(1);
    db.close();
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

  it('persists start dates for voice-role media discovered by staff filmography', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeFilmographyResponse());
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    const row = db.selectObject(
      'SELECT start_year, start_month, start_day FROM media WHERE id = 1001',
    );
    expect(row).toEqual({
      start_year: 2026,
      start_month: null,
      start_day: null,
    });
    db.close();
  });

  it('keeps voice-role media yearless when AniList has no announced start date', async () => {
    const db = await freshAnilistDb();
    const response = makeFilmographyResponse();
    const media = response.Staff?.characterMedia?.edges[0]?.node;
    if (media) {
      media.startDate = { year: null, month: null, day: null };
    }
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery: vi.fn().mockResolvedValue(response),
      now: () => NOW,
    };

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(db.selectObject('SELECT start_year FROM media WHERE id = 1001')).toEqual({
      start_year: null,
    });
    db.close();
  });

  it('refreshes every stored profile field for the selected staff member', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(
      makeFilmographyResponse({
        name: { full: 'Updated Staff', native: '更新 スタッフ' },
        image: { large: 'https://example.test/updated-staff.jpg' },
        age: '42',
        gender: 'Male',
        languageV2: 'Japanese',
        favourites: 1234,
      }),
    );
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };
    db.exec(
      `INSERT INTO staff (
         id, name_full, name_native, image, age, gender, language_v2,
         favourites, fetched_at, updated_at
       ) VALUES (
         ?, 'Stale Staff', '古い スタッフ', 'https://example.test/stale.jpg',
         '99', 'Female', 'English', 1, 1, 1
       )`,
      { bind: [VA_STAFF_ID] },
    );

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    const row = db.selectObject(
      `SELECT name_full, name_native, image, age, gender, language_v2,
              favourites, fetched_at, updated_at
         FROM staff
        WHERE id = ?`,
      VA_STAFF_ID,
    );
    expect(row).toEqual({
      name_full: 'Updated Staff',
      name_native: '更新 スタッフ',
      image: 'https://example.test/updated-staff.jpg',
      age: '42',
      gender: 'Male',
      language_v2: 'Japanese',
      favourites: 1234,
      fetched_at: NOW,
      updated_at: NOW,
    });
    db.close();
  });

  it('replaces studio and tag junctions for production-credit media', async () => {
    const db = await freshAnilistDb();
    const response = makeFilmographyResponse();
    response.Staff!.staffMedia!.edges = [
      {
        staffRole: 'Director',
        node: fullMedia({
          studios: {
            edges: [
              {
                isMain: true,
                node: { id: 11, name: 'Current Studio' },
              },
            ],
          },
          tags: [{ name: 'Current Tag', rank: 90 }],
        }),
      },
    ];
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery: vi.fn().mockResolvedValue(response),
      now: () => NOW,
    };
    db.exec(
      `INSERT INTO media (id, type, fetched_at, updated_at)
       VALUES (1002, 'ANIME', 1, 1)`,
    );
    db.exec(
      `INSERT INTO studio (id, name, fetched_at)
       VALUES (10, 'Stale Studio', 1)`,
    );
    db.exec(
      `INSERT INTO media_studio (media_id, studio_id, sort_order, is_main)
       VALUES (1002, 10, 0, 1)`,
    );
    db.exec(
      `INSERT INTO tag (name, fetched_at)
       VALUES ('Stale Tag', 1)`,
    );
    db.exec(
      `INSERT INTO media_tag (media_id, tag_name, rank)
       VALUES (1002, 'Stale Tag', 50)`,
    );

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(
      db.selectObjects(
        `SELECT s.id, s.name, ms.is_main
           FROM media_studio ms
           JOIN studio s ON s.id = ms.studio_id
          WHERE ms.media_id = 1002`,
      ),
    ).toEqual([{ id: 11, name: 'Current Studio', is_main: 1 }]);
    expect(
      db.selectObjects(
        `SELECT tag_name, rank
           FROM media_tag
          WHERE media_id = 1002`,
      ),
    ).toEqual([{ tag_name: 'Current Tag', rank: 90 }]);
    expect(
      db.selectObject(
        'SELECT studios_fetched_at FROM media WHERE id = 1002',
      ),
    ).toEqual({ studios_fetched_at: NOW });
    db.close();
  });

  it('removes obsolete voice and production credits on refresh', async () => {
    const db = await freshAnilistDb();
    const initialResponse = makeFilmographyResponse();
    initialResponse.Staff!.staffMedia!.edges = [
      {
        staffRole: 'Director',
        node: fullMedia(),
      },
    ];
    const refreshedResponse = makeFilmographyResponse();
    refreshedResponse.Staff!.characterMedia!.edges = [];
    refreshedResponse.Staff!.staffMedia!.edges = [];
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery: vi
        .fn()
        .mockResolvedValueOnce(initialResponse)
        .mockResolvedValueOnce(refreshedResponse),
      now: () => NOW,
    };

    await expandStaffFilmography(ctx, VA_STAFF_ID);
    expect(
      db.selectObject(
        'SELECT COUNT(*) AS count FROM character_voice_actor WHERE staff_id = ?',
        VA_STAFF_ID,
      ),
    ).toEqual({ count: 1 });
    expect(
      db.selectObject(
        'SELECT COUNT(*) AS count FROM media_staff WHERE staff_id = ?',
        VA_STAFF_ID,
      ),
    ).toEqual({ count: 1 });

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    expect(
      db.selectObject(
        'SELECT COUNT(*) AS count FROM character_voice_actor WHERE staff_id = ?',
        VA_STAFF_ID,
      ),
    ).toEqual({ count: 0 });
    expect(
      db.selectObject(
        'SELECT COUNT(*) AS count FROM media_staff WHERE staff_id = ?',
        VA_STAFF_ID,
      ),
    ).toEqual({ count: 0 });
    db.close();
  });

  it('does not wipe existing media source when characterMedia nodes omit it', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeFilmographyResponse());
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    db.exec(
      `INSERT INTO media (
         id, type, title_romaji, title_english, title_native, cover_image, format,
         source, status, episodes, chapters, start_year, start_month, start_day,
         end_year, end_month, end_day, season, season_year, mean_score, favourites,
         country_of_origin, genres_json, synonyms_json, fetched_at, updated_at
       ) VALUES (
         1001, 'ANIME', 'Kimisui', NULL, NULL, NULL, 'MOVIE',
         'WEB_NOVEL', 'FINISHED', 1, NULL, 2018, 9, 1,
         2018, 9, 1, 'FALL', 2018, 85, 1000,
         'JP', '[]', '[]', ?, ?
       )`,
      { bind: [NOW, NOW] },
    );
    db.exec(
      `INSERT INTO staff (
         id, name_full, name_native, image, age, gender, language_v2, favourites, fetched_at, updated_at
       ) VALUES (?, 'Test VA', NULL, NULL, NULL, 'Female', NULL, NULL, ?, ?)`,
      { bind: [VA_STAFF_ID, NOW, NOW] },
    );

    await expandStaffFilmography(ctx, VA_STAFF_ID);

    const row = db.selectObject('SELECT source FROM media WHERE id = 1001');
    expect(row).toEqual({ source: 'WEB_NOVEL' });
    db.close();
  });
});
