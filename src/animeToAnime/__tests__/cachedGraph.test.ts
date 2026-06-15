import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../lib/db/__tests__/testSqlite';
import { migrate } from '../../lib/db/migration-runner';
import { anilistSourceDescriptor } from '../../lib/importers/anilist/anilistSource';
import type { AnilistDbExecutor } from '../../lib/importers/anilist/context';
import type { RoundConfig } from '../preferences';
import {
  buildCachedShortestPathStream,
  findCachedOptimalPath,
  type CachedShortestPathStream,
} from '../cachedGraph';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

const NOW = 1_700_000_000_000;

const DEFAULT_RULES: RoundConfig = {
  allowProduction: true,
  allowRelations: true,
  productionAllRoles: false,
};

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

function seedMedia(db: Database, id: number, title = `title-${id}`): void {
  db.exec(
    `INSERT INTO media (id, type, title_english, title_romaji, fetched_at, updated_at)
       VALUES (?, 'ANIME', ?, ?, ?, ?)`,
    { bind: [id, title, title, NOW, NOW] },
  );
}

function seedStaff(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO staff (id, name_full, fetched_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    { bind: [id, name, NOW, NOW] },
  );
}

function seedCharacter(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO character (id, name_full, fetched_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    { bind: [id, name, NOW, NOW] },
  );
}

function seedVaLink(
  db: Database,
  mediaId: number,
  characterId: number,
  staffId: number,
): void {
  db.exec(
    `INSERT INTO media_character (media_id, character_id, role, sort_order)
       VALUES (?, ?, 'MAIN', 0)`,
    { bind: [mediaId, characterId] },
  );
  db.exec(
    `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
       VALUES (?, ?, ?, 'JAPANESE')`,
    { bind: [mediaId, characterId, staffId] },
  );
}

function seedProductionLink(
  db: Database,
  mediaId: number,
  staffId: number,
  role = 'Director',
): void {
  db.exec(
    `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
       VALUES (?, ?, ?, 0)`,
    { bind: [mediaId, staffId, role] },
  );
}

function seedRelation(db: Database, fromId: number, toId: number): void {
  db.exec(
    `INSERT INTO media_relation (from_media_id, to_media_id, relation_type)
       VALUES (?, ?, 'SEQUEL')`,
    { bind: [fromId, toId] },
  );
}

async function freshAnilistDb(): Promise<{ db: Database; adapter: AnilistDbExecutor }> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return { db, adapter: makeDbAdapter(db) };
}

function solve(
  adapter: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  maxLinks: number,
  rules: RoundConfig = DEFAULT_RULES,
) {
  return findCachedOptimalPath({
    db: adapter,
    startMediaId,
    goalMediaId,
    rules,
    maxLinks,
  });
}

describe('findCachedOptimalPath', () => {
  let adapter: AnilistDbExecutor;
  let sqlite: Database;

  beforeEach(async () => {
    const fresh = await freshAnilistDb();
    adapter = fresh.adapter;
    sqlite = fresh.db;
  });

  it('finds a 1-link path through shared voice staff', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Goal');
    seedStaff(sqlite, 10, 'Shared VA');
    seedCharacter(sqlite, 100, 'Hero');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);

    const result = await solve(adapter, 1, 2, 3);
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(1);
    expect(result.steps.map((s) => (s.kind === 'anime' ? s.mediaId : s.staffId))).toEqual([
      1, 10, 2,
    ]);
  });

  it('finds a 2-link path start → staff → mid → staff → goal', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Mid');
    seedMedia(sqlite, 3, 'Goal');
    seedStaff(sqlite, 10, 'VA A');
    seedStaff(sqlite, 11, 'VA B');
    seedCharacter(sqlite, 100, 'Hero A');
    seedCharacter(sqlite, 101, 'Hero B');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);
    seedVaLink(sqlite, 2, 101, 11);
    seedVaLink(sqlite, 3, 101, 11);

    const result = await solve(adapter, 1, 3, 3);
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(2);
    expect(result.steps.filter((s) => s.kind === 'anime').map((s) => s.mediaId)).toEqual([
      1, 2, 3,
    ]);
  });

  it('counts a franchise relation as a 1-link path', async () => {
    seedMedia(sqlite, 1, 'Show A');
    seedMedia(sqlite, 2, 'Show B');
    seedRelation(sqlite, 1, 2);

    const result = await solve(adapter, 1, 2, 2);
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(1);
    expect(result.steps.map((s) => s.kind === 'anime' && s.mediaId)).toEqual([1, 2]);
  });

  it('uses direct 1-link precheck for shared VA without full BFS', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Goal');
    seedStaff(sqlite, 10, 'Shared VA');
    seedCharacter(sqlite, 100, 'Hero');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);

    const result = await solve(adapter, 1, 2, 1);
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(1);
  });

  it('removes production-only bridges when production is disabled', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Goal');
    seedStaff(sqlite, 20, 'Director');
    seedProductionLink(sqlite, 1, 20, 'Director');
    seedProductionLink(sqlite, 2, 20, 'Director');

    const result = await solve(adapter, 1, 2, 2, {
      allowProduction: false,
      allowRelations: false,
      productionAllRoles: false,
    });
    expect(result.status).toBe('not_found');
  });

  it('treats franchise relations as undirected', async () => {
    seedMedia(sqlite, 1, 'Sequel');
    seedMedia(sqlite, 2, 'Prequel');
    seedRelation(sqlite, 2, 1);

    const result = await solve(adapter, 1, 2, 2);
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(1);
  });

  it('does not return a 2-link path when maxLinks is 1', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Mid');
    seedMedia(sqlite, 3, 'Goal');
    seedStaff(sqlite, 10, 'VA A');
    seedStaff(sqlite, 11, 'VA B');
    seedCharacter(sqlite, 100, 'Hero A');
    seedCharacter(sqlite, 101, 'Hero B');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);
    seedVaLink(sqlite, 2, 101, 11);
    seedVaLink(sqlite, 3, 101, 11);

    const result = await solve(adapter, 1, 3, 1);
    expect(result.status).toBe('not_found');
  });

  it('returns not_found when the cached graph is disconnected', async () => {
    seedMedia(sqlite, 1, 'Isolated A');
    seedMedia(sqlite, 2, 'Isolated B');

    const result = await solve(adapter, 1, 2, 3);
    expect(result.status).toBe('not_found');
  });

  it('uses production filmography hops even when show-page production is disabled', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 3, 'Goal');
    seedStaff(sqlite, 30, 'Composer');
    seedCharacter(sqlite, 100, 'Lead');
    seedVaLink(sqlite, 1, 100, 30);
    seedProductionLink(sqlite, 3, 30, 'Music');

    const result = await solve(adapter, 1, 3, 3, {
      allowProduction: false,
      allowRelations: false,
      productionAllRoles: false,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      return;
    }
    expect(result.linksUsed).toBe(1);
    expect(result.steps.map((s) => (s.kind === 'anime' ? s.mediaId : s.staffId))).toEqual([
      1, 30, 3,
    ]);
  });
});

/** Pull every path the stream yields, returning each as its node-id
 *  sequence (anime media ids + staff ids interleaved) plus the final
 *  exhaustion total. */
async function collectStreamPaths(
  stream: CachedShortestPathStream,
): Promise<{ paths: number[][]; total: number }> {
  const paths: number[][] = [];
  for (;;) {
    const result = await stream.next();
    if (result.status === 'exhausted') {
      return { paths, total: result.total };
    }
    paths.push(
      result.steps.map((s) => (s.kind === 'anime' ? s.mediaId : s.staffId)),
    );
  }
}

describe('buildCachedShortestPathStream', () => {
  let adapter: AnilistDbExecutor;
  let sqlite: Database;

  beforeEach(async () => {
    const fresh = await freshAnilistDb();
    adapter = fresh.adapter;
    sqlite = fresh.db;
  });

  function build(
    startMediaId: number,
    goalMediaId: number,
    maxLinks?: number,
    rules: RoundConfig = DEFAULT_RULES,
  ) {
    return buildCachedShortestPathStream({
      db: adapter,
      startMediaId,
      goalMediaId,
      rules,
      maxLinks,
    });
  }

  it('enumerates both bridges to the same anime without deduping', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Goal');
    seedStaff(sqlite, 10, 'VA One');
    seedStaff(sqlite, 11, 'VA Two');
    seedCharacter(sqlite, 100, 'Hero A');
    seedCharacter(sqlite, 101, 'Hero B');
    // Two independent shared voice actors connect Start and Goal directly.
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);
    seedVaLink(sqlite, 1, 101, 11);
    seedVaLink(sqlite, 2, 101, 11);

    const built = await build(1, 2);
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') {
      return;
    }
    expect(built.stream.optimalLinks).toBe(1);

    const { paths, total } = await collectStreamPaths(built.stream);
    expect(total).toBe(2);
    // Same two anime endpoints, reached via each distinct staff member.
    const sorted = [...paths].sort((a, b) => a[1] - b[1]);
    expect(sorted).toEqual([
      [1, 10, 2],
      [1, 11, 2],
    ]);
  });

  it('only yields optimal-length paths, never longer alternatives', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Mid');
    seedMedia(sqlite, 3, 'Goal');
    seedStaff(sqlite, 10, 'Direct VA');
    seedStaff(sqlite, 11, 'Mid VA A');
    seedStaff(sqlite, 12, 'Mid VA B');
    seedCharacter(sqlite, 100, 'Hero Direct');
    seedCharacter(sqlite, 101, 'Hero A');
    seedCharacter(sqlite, 102, 'Hero B');
    // 1-link direct bridge Start↔Goal.
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 3, 100, 10);
    // A longer 2-link route Start→Mid→Goal that must be excluded.
    seedVaLink(sqlite, 1, 101, 11);
    seedVaLink(sqlite, 2, 101, 11);
    seedVaLink(sqlite, 2, 102, 12);
    seedVaLink(sqlite, 3, 102, 12);

    const built = await build(1, 3);
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') {
      return;
    }
    expect(built.stream.optimalLinks).toBe(1);

    const { paths, total } = await collectStreamPaths(built.stream);
    expect(total).toBe(1);
    expect(paths).toEqual([[1, 10, 3]]);
  });

  it('reports exhaustion after the single shortest path', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Goal');
    seedStaff(sqlite, 10, 'Shared VA');
    seedCharacter(sqlite, 100, 'Hero');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);

    const built = await build(1, 2);
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') {
      return;
    }

    const first = await built.stream.next();
    expect(first.status).toBe('found');
    const second = await built.stream.next();
    expect(second).toEqual({ status: 'exhausted', total: 1 });
  });

  it('returns not_found when the optimum exceeds the maxLinks bound', async () => {
    seedMedia(sqlite, 1, 'Start');
    seedMedia(sqlite, 2, 'Mid');
    seedMedia(sqlite, 3, 'Goal');
    seedStaff(sqlite, 10, 'VA A');
    seedStaff(sqlite, 11, 'VA B');
    seedCharacter(sqlite, 100, 'Hero A');
    seedCharacter(sqlite, 101, 'Hero B');
    seedVaLink(sqlite, 1, 100, 10);
    seedVaLink(sqlite, 2, 100, 10);
    seedVaLink(sqlite, 2, 101, 11);
    seedVaLink(sqlite, 3, 101, 11);

    const built = await build(1, 3, 1);
    expect(built.status).toBe('not_found');
  });

  it('signals "same" when start equals goal', async () => {
    seedMedia(sqlite, 1, 'Solo');
    const built = await build(1, 1);
    expect(built.status).toBe('same');
  });

  it('returns not_found for a disconnected cache', async () => {
    seedMedia(sqlite, 1, 'Isolated A');
    seedMedia(sqlite, 2, 'Isolated B');
    const built = await build(1, 2);
    expect(built.status).toBe('not_found');
  });
});
