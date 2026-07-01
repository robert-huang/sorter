import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { _clearDbSyncManifestForTesting } from '../../../db/syncManifest';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import { expandCharacterMedia } from '../expandCharacterMedia';
import type { AnilistCharacterVoiceMediaResponse } from '../types';

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
const MIYAKO_STAFF_ID = 95001;
const FAVOURITE_CHAR_ID = 88001;

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

function makeVoiceMediaResponse(): AnilistCharacterVoiceMediaResponse {
  return {
    Character: {
      id: FAVOURITE_CHAR_ID,
      media: {
        pageInfo: { hasNextPage: false, currentPage: 1 },
        edges: [
          {
            characterRole: 'MAIN',
            node: {
              id: 1001,
              title: { romaji: 'Test Anime', native: null, english: null },
              type: 'ANIME',
              format: 'TV',
              coverImage: { large: 'https://example.test/cover.jpg' },
            } as never,
            voiceActors: [
              {
                id: MIYAKO_STAFF_ID,
                name: { full: 'Miyako Ishida', native: '石田 美代子' },
                image: { large: 'https://example.test/miyako.jpg' },
                age: null,
                gender: null,
                languageV2: null,
                favourites: null,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('expandCharacterMedia', () => {
  beforeEach(() => {
    _clearDbSyncManifestForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wipe existing staff gender when voice-actor nodes omit profile fields', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeVoiceMediaResponse());
    const ctx: AnilistImportContext = {
      db: makeDbAdapter(db),
      executeQuery,
      now: () => NOW,
    };

    db.exec(
      `INSERT INTO staff (
         id, name_full, name_native, image, age, gender, language_v2, favourites, fetched_at, updated_at
       ) VALUES (?, 'Miyako Ishida', '石田 美代子', NULL, NULL, 'Female', NULL, NULL, ?, ?)`,
      { bind: [MIYAKO_STAFF_ID, NOW, NOW] },
    );
    db.exec(
      `INSERT INTO character (
         id, name_full, name_native, name_alternatives_json, name_alternatives_spoiler_json,
         image, age, gender, favourites, birth_year, birth_month, birth_day, fetched_at, updated_at
       ) VALUES (?, 'Fav Char', NULL, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      { bind: [FAVOURITE_CHAR_ID, NOW, NOW] },
    );

    const result = await expandCharacterMedia(ctx, FAVOURITE_CHAR_ID);

    expect(result).toMatchObject({
      characterId: FAVOURITE_CHAR_ID,
      cvaWritten: 1,
    });

    const row = db.selectObject('SELECT gender FROM staff WHERE id = ?', MIYAKO_STAFF_ID);
    expect(row).toEqual({ gender: 'Female' });
    db.close();
  });

  it('does not wipe existing media source when character-media nodes omit it', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeVoiceMediaResponse());
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
      `INSERT INTO character (
         id, name_full, name_native, name_alternatives_json, name_alternatives_spoiler_json,
         image, age, gender, favourites, birth_year, birth_month, birth_day, fetched_at, updated_at
       ) VALUES (?, 'Fav Char', NULL, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      { bind: [FAVOURITE_CHAR_ID, NOW, NOW] },
    );

    await expandCharacterMedia(ctx, FAVOURITE_CHAR_ID);

    const row = db.selectObject('SELECT source FROM media WHERE id = 1001');
    expect(row).toEqual({ source: 'WEB_NOVEL' });
    db.close();
  });

  it('does not wipe existing media synonyms when character-media nodes omit them', async () => {
    const db = await freshAnilistDb();
    const executeQuery = vi.fn().mockResolvedValue(makeVoiceMediaResponse());
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
         'JP', '[]', '["Let Me Eat Your Pancreas"]', ?, ?
       )`,
      { bind: [NOW, NOW] },
    );
    db.exec(
      `INSERT INTO character (
         id, name_full, name_native, name_alternatives_json, name_alternatives_spoiler_json,
         image, age, gender, favourites, birth_year, birth_month, birth_day, fetched_at, updated_at
       ) VALUES (?, 'Fav Char', NULL, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      { bind: [FAVOURITE_CHAR_ID, NOW, NOW] },
    );

    await expandCharacterMedia(ctx, FAVOURITE_CHAR_ID);

    const row = db.selectObject('SELECT synonyms_json FROM media WHERE id = 1001');
    expect(row).toEqual({ synonyms_json: '["Let Me Eat Your Pancreas"]' });
    db.close();
  });
});
