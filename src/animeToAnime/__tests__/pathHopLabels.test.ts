import type { Database } from '@sqlite.org/sqlite-wasm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../lib/db/__tests__/testSqlite';
import { migrate } from '../../lib/db/migration-runner';
import { anilistSourceDescriptor } from '../../lib/importers/anilist/anilistSource';
import type { AnilistDbExecutor } from '../../lib/importers/anilist/context';
import { annotatePathViaLabels } from '../pathHopLabels';
import type { PathStep } from '../pathHistory';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

const NOW = 1_700_000_000_000;

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

async function freshAnilistDb(): Promise<{ db: Database; adapter: AnilistDbExecutor }> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return { db, adapter: makeDbAdapter(db) };
}

describe('annotatePathViaLabels', () => {
  let adapter: AnilistDbExecutor;
  let sqlite: Database;

  beforeEach(async () => {
    const fresh = await freshAnilistDb();
    adapter = fresh.adapter;
    sqlite = fresh.db;
  });

  it('prefers voice character credits over production when both link staff to a show', async () => {
    sqlite.exec(
      `INSERT INTO media (id, type, title_english, fetched_at, updated_at)
         VALUES (1, 'ANIME', 'Show', ?, ?)`,
      { bind: [NOW, NOW] },
    );
    sqlite.exec(
      `INSERT INTO staff (id, name_full, fetched_at, updated_at) VALUES (10, 'Dual Role', ?, ?)`,
      { bind: [NOW, NOW] },
    );
    sqlite.exec(
      `INSERT INTO character (id, name_full, fetched_at, updated_at) VALUES (100, 'Hero', ?, ?)`,
      { bind: [NOW, NOW] },
    );
    sqlite.exec(
      `INSERT INTO media_character (media_id, character_id, role, sort_order)
         VALUES (1, 100, 'MAIN', 0)`,
    );
    sqlite.exec(
      `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
         VALUES (1, 100, 10, 'JAPANESE')`,
    );
    sqlite.exec(
      `INSERT INTO media_staff (media_id, staff_id, role, sort_order)
         VALUES (1, 10, 'Music', 0)`,
    );

    const nodes = [
      { kind: 'anime' as const, id: 1 },
      { kind: 'staff' as const, id: 10 },
    ];
    const steps: PathStep[] = [
      { kind: 'anime', mediaId: 1, title: 'Show', coverImage: null },
      { kind: 'staff', staffId: 10, name: 'Dual Role', image: null },
    ];

    const annotated = await annotatePathViaLabels(adapter, nodes, steps, {
      allowProduction: true,
      allowRelations: false,
      productionAllRoles: false,
    });

    expect(annotated[1].viaLabel).toMatch(/Hero \(MAIN\)/);
    expect(annotated[1].viaLabel).not.toMatch(/Music/);
  });
});
