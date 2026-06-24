import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor } from '../context';
import { GRAPH_STALE_MS } from '../graphConstants';
import { isCharacterVoiceEdgesDbFresh } from '../toolsAnilistAccess';
import type { CharacterMediaEdge } from '../../../../tools/panels/favouritesLogic';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

const NOW = Date.now();

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
    async execBatch() {
      /* no-op */
    },
  };
}

function seedMedia(db: Database, id: number): void {
  db.exec(
    `INSERT INTO media (id, type, title_english, fetched_at, updated_at)
       VALUES (?, 'ANIME', ?, ?, ?)`,
    { bind: [id, `title-${id}`, NOW, NOW] },
  );
}

function seedCastExpansion(
  db: Database,
  mediaId: number,
  charactersFetchedAt: number,
  charactersComplete = 1,
): void {
  seedMedia(db, mediaId);
  db.exec(
    `INSERT INTO media_cast_expansion (
       media_id, language, fetched_at, characters_fetched_at, staff_fetched_at,
       characters_complete, staff_complete
     ) VALUES (?, 'JAPANESE', ?, ?, ?, ?, 1)`,
    {
      bind: [mediaId, charactersFetchedAt, charactersFetchedAt, charactersFetchedAt, charactersComplete],
    },
  );
}

const sampleEdges: CharacterMediaEdge[] = [
  {
    node: {
      id: 100,
      title: { romaji: 'Show', native: null, english: null },
      type: 'ANIME',
      format: null,
    },
    characterRole: 'MAIN',
    voiceActors: [{ id: 1, name: { full: 'VA', native: null } }],
  },
];

describe('isCharacterVoiceEdgesDbFresh', () => {
  let adapter: AnilistDbExecutor;
  let sqlite: Database;

  beforeEach(async () => {
    sqlite = await openMemoryDb();
    sqlite.exec('PRAGMA foreign_keys = ON');
    migrate(sqlite, anilistSourceDescriptor);
    adapter = makeDbAdapter(sqlite);
  });

  it('returns false when there are no edges', async () => {
    expect(await isCharacterVoiceEdgesDbFresh(adapter, [])).toBe(false);
  });

  it('returns false when cast expansion is missing', async () => {
    expect(await isCharacterVoiceEdgesDbFresh(adapter, sampleEdges)).toBe(false);
  });

  it('returns false when cast expansion is older than 90 days', async () => {
    seedCastExpansion(sqlite, 100, NOW - GRAPH_STALE_MS - 1);
    expect(await isCharacterVoiceEdgesDbFresh(adapter, sampleEdges)).toBe(false);
  });

  it('returns false when characters expansion is incomplete', async () => {
    seedCastExpansion(sqlite, 100, NOW, 0);
    expect(await isCharacterVoiceEdgesDbFresh(adapter, sampleEdges)).toBe(false);
  });

  it('returns true when every appearance media has fresh complete cast', async () => {
    seedCastExpansion(sqlite, 100, NOW);
    expect(await isCharacterVoiceEdgesDbFresh(adapter, sampleEdges)).toBe(true);
  });
});
