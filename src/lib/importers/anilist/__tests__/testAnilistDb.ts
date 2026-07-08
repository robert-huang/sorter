import type { Database } from '@sqlite.org/sqlite-wasm';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor, AnilistImportContext } from '../context';

type ExecCapable = { exec: (sql: string, opts?: { bind?: unknown }) => void };

export const TEST_ANILIST_NOW = 1_700_000_000_000;

export function makeAnilistDbAdapter(db: Database): AnilistDbExecutor {
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

export async function openTestAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

export function makeTestAnilistImportContext(
  db: Database,
  overrides: Partial<AnilistImportContext> = {},
): AnilistImportContext {
  return {
    db: makeAnilistDbAdapter(db),
    executeQuery: overrides.executeQuery ?? (async () => null),
    now: overrides.now ?? (() => TEST_ANILIST_NOW),
    ...overrides,
  };
}

export function seedMediaRow(
  db: Database,
  id: number,
  type: 'ANIME' | 'MANGA' = 'ANIME',
  title = `title-${id}`,
): void {
  db.exec(
    `INSERT INTO media (id, type, title_english, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    { bind: [id, type, title, TEST_ANILIST_NOW, TEST_ANILIST_NOW] },
  );
}
