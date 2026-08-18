import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';
import {
  expandMediaThemeSongs,
  getMediaThemeSongsExpansion,
} from '../expandMediaThemeSongs';

type ExecCapable = { exec: (sql: string, opts?: { bind?: unknown }) => void };

function makeDbAdapter(db: Database): AnilistDbExecutor {
  return {
    async exec(sql, params) {
      if (/^\s*(select|pragma)/i.test(sql)) {
        return params && params.length > 0
          ? (db.selectObjects(sql, params as never) as never)
          : (db.selectObjects(sql) as never);
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

describe('expandMediaThemeSongs', () => {
  let db: Database;
  let adapter: AnilistDbExecutor;
  let executeQuery: ReturnType<typeof vi.fn>;
  let dirty: ReturnType<typeof vi.fn>;
  let ctx: AnilistImportContext;

  beforeEach(async () => {
    db = await openMemoryDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, anilistSourceDescriptor);
    adapter = makeDbAdapter(db);
    executeQuery = vi.fn();
    dirty = vi.fn();
    ctx = {
      executeQuery,
      db: adapter,
      now: () => 1_700_000_000_000,
      onDirtyIncrement: dirty,
    };
  });

  it('fetches and persists the minimal media row when the show was not cached', async () => {
    executeQuery.mockResolvedValueOnce({
      Media: {
        id: 42,
        idMal: null,
        type: 'ANIME',
        title: {
          english: 'Uncached Show',
          romaji: 'Uncached Show Romaji',
          native: null,
        },
        coverImage: { large: 'https://example.test/cover.jpg' },
        format: 'TV',
        startDate: { year: 2026, month: 7, day: 1 },
        synonyms: ['Uncached'],
      },
    });

    const result = await expandMediaThemeSongs(ctx, 42);

    expect(result).toEqual({
      mediaId: 42,
      malId: null,
      rowsWritten: 0,
      aniplaylistAvailable: true,
    });
    expect(executeQuery).toHaveBeenCalledWith(
      expect.stringContaining('query MediaThemeSongs'),
      { id: 42 },
    );
    const mediaRows = await adapter.exec(
      `SELECT id, type, title_english, title_romaji
         FROM media WHERE id = ?`,
      [42],
    );
    expect(mediaRows).toEqual([
      {
        id: 42,
        type: 'ANIME',
        title_english: 'Uncached Show',
        title_romaji: 'Uncached Show Romaji',
      },
    ]);
    const expansionRows = await adapter.exec(
      'SELECT media_id, mal_id FROM media_theme_songs_expansion WHERE media_id = ?',
      [42],
    );
    expect(expansionRows).toEqual([{ media_id: 42, mal_id: null }]);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledWith({
      kind: 'media-theme-songs',
      mediaId: 42,
      payload: expect.objectContaining({ rows: [] }),
    });
  });

  it('normalizes shared aliases when reading an existing cached payload', async () => {
    const spotifyUrl = 'https://open.spotify.com/track/4uU8sWDoApg5yFEdwrrxUd';
    const spotifyTrackIds = ['4uU8sWDoApg5yFEdwrrxUd'];
    const payload = {
      version: 1 as const,
      aniplaylistAvailable: true,
      rows: [
        {
          type: 'Insert' as const,
          sortOrder: 4,
          displayTitle: `You've Got Friends ~Anata ni wa Tomodachi ga Iru~`,
          displayArtist: 'Tao Tsuchiya',
          aniTitles: [
            `You've Got Friends ~Anata ni wa Tomodachi ga Iru~`,
            `You've Got Friends ~あなたには友達がいる~`,
          ],
          aniArtists: ['Tao Tsuchiya', '土屋太鳳'],
          spotifyUrl,
          spotifyTrackIds,
          spotifyIsrc: null,
          hasResolvableTrackId: true,
        },
        {
          type: 'Ending' as const,
          sortOrder: 0,
          displayTitle: `You've Got Friends (あなたには友達がい)`,
          displayArtist: 'Tao Tsuchiya',
          malTitle: `You've Got Friends (あなたには友達がい)`,
          malArtist: 'Tao Tsuchiya',
          spotifyUrl,
          spotifyTrackIds,
          spotifyIsrc: null,
          hasResolvableTrackId: true,
        },
      ],
    };
    const readDb: AnilistDbExecutor = {
      exec: vi.fn().mockResolvedValue([
        {
          media_id: 123899,
          mal_id: 42847,
          fetched_at: 1_700_000_000_000,
          payload_json: JSON.stringify(payload),
        },
      ]),
      execBatch: vi.fn(),
    };

    const expansion = await getMediaThemeSongsExpansion(readDb, 123899);

    expect(expansion?.payload.rows[1]).toMatchObject({
      aniTitles: payload.rows[0].aniTitles,
      aniArtists: payload.rows[0].aniArtists,
      spotifyTrackIds,
    });
  });
});
