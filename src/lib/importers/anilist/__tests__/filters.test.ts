/**
 * Phase D: AniList filter chips. Covers
 *   - `buildAnilistFilterSql` as a pure function (clause/param fixtures).
 *   - `computeAllowedMediaIds` end-to-end against an in-memory anilist.sqlite
 *     so the SQL the builder produces actually runs and filters the right
 *     ids — catches regressions where a builder change passes the fixture
 *     test but breaks the SQL semantically (bind ordering, JOIN columns).
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor } from '../context';
import {
  ANILIST_INITIAL_CHIP_STATE,
  buildAnilistFilterSql,
  computeAllowedMediaIds,
  setFilterDbForTesting,
  type AnilistFilterChipState,
} from '../filters';

type SqliteExecOpts = { bind?: unknown };
type ExecCapable = { exec: (sql: string, opts?: SqliteExecOpts) => void };

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

async function freshAnilistDb(): Promise<Database> {
  const db = await openMemoryDb();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, anilistSourceDescriptor);
  return db;
}

// Build a chip state by patching the initial all-off state.
function chips(patch: Partial<AnilistFilterChipState>): AnilistFilterChipState {
  return { ...ANILIST_INITIAL_CHIP_STATE, ...patch };
}

// ---------------------------------------------------------------------
// Seed helpers (terse — only the columns each test cares about)
// ---------------------------------------------------------------------

function seedMedia(
  db: Database,
  id: number,
  o: Partial<{
    type: 'ANIME' | 'MANGA';
    format: string | null;
    season: string | null;
    season_year: number | null;
    start_year: number | null;
    status: string | null;
    mean_score: number | null;
    genres_json: string | null;
  }> = {},
): void {
  const row = {
    type: 'ANIME',
    format: 'TV',
    season: null as string | null,
    season_year: null as number | null,
    start_year: null as number | null,
    status: 'FINISHED',
    mean_score: null as number | null,
    genres_json: '[]',
    ...o,
  };
  db.exec(
    `INSERT INTO media (
      id, type, title_english, title_romaji, title_native, cover_image,
      format, status, episodes, chapters, start_year, start_month, start_day,
      end_year, end_month, end_day, season, season_year, mean_score, favourites,
      country_of_origin, genres_json, synonyms_json, fetched_at, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL,
              NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0)`,
    {
      bind: [
        id,
        row.type,
        row.format,
        row.status,
        row.start_year,
        row.season,
        row.season_year,
        row.mean_score,
        row.genres_json,
      ],
    } as never,
  );
}

function seedStudio(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO studio (id, name, fetched_at) VALUES (?, ?, 0)`,
    { bind: [id, name] } as never,
  );
}

function linkStudio(db: Database, mediaId: number, studioId: number): void {
  db.exec(
    `INSERT INTO media_studio (media_id, studio_id, sort_order) VALUES (?, ?, 0)`,
    { bind: [mediaId, studioId] } as never,
  );
}

function seedTag(db: Database, name: string): void {
  db.exec(`INSERT INTO tag (name, fetched_at) VALUES (?, 0)`, { bind: [name] } as never);
}

function linkTag(db: Database, mediaId: number, name: string, rank: number): void {
  db.exec(
    `INSERT INTO media_tag (media_id, tag_name, rank) VALUES (?, ?, ?)`,
    { bind: [mediaId, name, rank] } as never,
  );
}

function seedUser(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO anilist_user (id, name, fetched_at, updated_at) VALUES (?, ?, 0, 0)`,
    { bind: [id, name] } as never,
  );
}

function seedFav(db: Database, userId: number, mediaId: number): void {
  db.exec(
    `INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at)
     VALUES (?, ?, 0, 0)`,
    { bind: [userId, mediaId] } as never,
  );
}

// =====================================================================
// buildAnilistFilterSql — pure function
// =====================================================================

describe('buildAnilistFilterSql', () => {
  it('returns null when no chips are active (caller can short-circuit)', () => {
    const out = buildAnilistFilterSql([1, 2, 3], ANILIST_INITIAL_CHIP_STATE);
    expect(out).toBeNull();
  });

  it('returns null when the candidate list is empty (avoid IN ()).', () => {
    const out = buildAnilistFilterSql([], chips({ genres: ['Action'] }));
    expect(out).toBeNull();
  });

  it('genres become anchored instr-lookups against genres_json', () => {
    const out = buildAnilistFilterSql([1], chips({ genres: ['Action'] }));
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/instr\(COALESCE\(m\.genres_json/);
    // Genre is bound as a quoted JSON token so 'Action' doesn't match
    // 'Action & Adventure' as a substring.
    expect(out!.params).toContain('"Action"');
  });

  it('emits IN clauses for years / formats / seasons / statuses with correct param counts', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({
        years: [2020, 2021],
        formats: ['TV', 'MOVIE'],
        seasons: ['WINTER'],
        statuses: ['FINISHED'],
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/m\.start_year IN \(\?, \?\)/);
    expect(out!.sql).toMatch(/m\.format IN \(\?, \?\)/);
    expect(out!.sql).toMatch(/m\.season IN \(\?\)/);
    expect(out!.sql).toMatch(/m\.status IN \(\?\)/);
    // The candidate id leads the param list, then each clause in order.
    expect(out!.params).toEqual([1, 2020, 2021, 'TV', 'MOVIE', 'WINTER', 'FINISHED']);
  });

  it('score buckets map low buckets to half-open ranges and bucket 9 to inclusive 90..100', () => {
    const out = buildAnilistFilterSql([1], chips({ scoreBuckets: [0, 9] }));
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/m\.mean_score >= \? AND m\.mean_score < \?/);
    expect(out!.sql).toMatch(/m\.mean_score >= \? AND m\.mean_score <= \?/);
    // params after the candidate id: bucket-0 range [0, 10), then bucket-9 range [90, 100].
    expect(out!.params).toEqual([1, 0, 10, 90, 100]);
  });

  it('score bucket -1 emits a literal IS NULL with no bound params', () => {
    const out = buildAnilistFilterSql([1], chips({ scoreBuckets: [-1] }));
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/m\.mean_score IS NULL/);
    expect(out!.params).toEqual([1]);
  });

  it('tag mode "or" uses EXISTS with rank threshold', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({ tagNames: ['a', 'b'], tagMode: 'or', tagMinRank: 60 }),
    );
    expect(out!.sql).toMatch(/EXISTS \(\s*SELECT 1 FROM media_tag/);
    expect(out!.sql).toMatch(/mt\.rank >= \?/);
    expect(out!.params).toEqual([1, 'a', 'b', 60]);
  });

  it('tag mode "and" uses COUNT(DISTINCT) = N', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({ tagNames: ['a', 'b'], tagMode: 'and', tagMinRank: 0 }),
    );
    expect(out!.sql).toMatch(/COUNT\(DISTINCT mt\.tag_name\)/);
    // tagNames, minRank, then the cardinality.
    expect(out!.params).toEqual([1, 'a', 'b', 0, 2]);
  });

  it('tagExclude emits NOT EXISTS with the excluded names', () => {
    const out = buildAnilistFilterSql([1], chips({ tagExclude: ['spoiler-a'] }));
    expect(out!.sql).toMatch(/NOT EXISTS/);
    expect(out!.params).toEqual([1, 'spoiler-a']);
  });

  it('combines multiple chips with AND in the WHERE clause', () => {
    const out = buildAnilistFilterSql(
      [1, 2],
      chips({ years: [2020], formats: ['TV'] }),
    );
    // Match the AND separator between clauses (allow whitespace).
    expect(out!.sql).toMatch(/m\.start_year IN \(\?\)\s+AND\s+m\.format IN \(\?\)/);
  });
});

// =====================================================================
// computeAllowedMediaIds — full path through the injected DB
// =====================================================================

describe('computeAllowedMediaIds', () => {
  let db: Database;

  beforeEach(async () => {
    db = await freshAnilistDb();
    setFilterDbForTesting(makeDbAdapter(db));
  });

  afterEach(() => {
    setFilterDbForTesting(null);
  });

  it('returns the candidate set unchanged when no chips are active', async () => {
    const allowed = await computeAllowedMediaIds([1, 2, 3], ANILIST_INITIAL_CHIP_STATE);
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('returns an empty set when the candidate list is empty', async () => {
    const allowed = await computeAllowedMediaIds([], chips({ genres: ['Action'] }));
    expect(allowed.size).toBe(0);
  });

  it('filters by year, ignoring rows outside the candidate set', async () => {
    seedMedia(db, 1, { start_year: 2020 });
    seedMedia(db, 2, { start_year: 2021 });
    seedMedia(db, 3, { start_year: 2021 });
    seedMedia(db, 4, { start_year: 2021 }); // not in candidate set
    const allowed = await computeAllowedMediaIds([1, 2, 3], chips({ years: [2021] }));
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('filters by genre using the anchored JSON token (no substring collisions)', async () => {
    seedMedia(db, 1, { genres_json: '["Action"]' });
    seedMedia(db, 2, { genres_json: '["Action & Adventure"]' });
    seedMedia(db, 3, { genres_json: '["Romance"]' });
    const allowed = await computeAllowedMediaIds([1, 2, 3], chips({ genres: ['Action'] }));
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1]);
  });

  it('filters by studio via the media_studio junction', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedStudio(db, 100, 'A');
    seedStudio(db, 200, 'B');
    linkStudio(db, 1, 100);
    linkStudio(db, 2, 200);
    const allowed = await computeAllowedMediaIds([1, 2], chips({ studioIds: [100] }));
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('tag AND mode requires every selected tag at rank >= minRank', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedTag(db, 'A');
    seedTag(db, 'B');
    // Media 1 has both at rank 80.
    linkTag(db, 1, 'A', 80);
    linkTag(db, 1, 'B', 80);
    // Media 2 has only A.
    linkTag(db, 2, 'A', 80);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ tagNames: ['A', 'B'], tagMode: 'and', tagMinRank: 50 }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('tag minRank threshold excludes weakly-tagged media in OR mode', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedTag(db, 'A');
    linkTag(db, 1, 'A', 30);
    linkTag(db, 2, 'A', 80);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ tagNames: ['A'], tagMode: 'or', tagMinRank: 70 }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('tagExclude drops every media that has any excluded tag', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedTag(db, 'Spoiler');
    linkTag(db, 1, 'Spoiler', 80);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ tagExclude: ['Spoiler'] }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('favourited="yes" keeps only ids favourited by the latest known user', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedUser(db, 999, 'me');
    seedFav(db, 999, 1);

    const allowed = await computeAllowedMediaIds([1, 2], chips({ favourited: 'yes' }));
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('favourited="no" keeps only ids NOT in the latest user\u2019s favourites', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedUser(db, 999, 'me');
    seedFav(db, 999, 1);

    const allowed = await computeAllowedMediaIds([1, 2], chips({ favourited: 'no' }));
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('favourited="yes" with zero anilist_user rows returns the empty set (honest about missing data)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    const allowed = await computeAllowedMediaIds([1, 2], chips({ favourited: 'yes' }));
    expect(allowed.size).toBe(0);
  });
});
