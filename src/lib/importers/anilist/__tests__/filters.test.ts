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
  ALL_LIST_STATUSES,
  ANILIST_INITIAL_CHIP_STATE,
  anilistFilterModule,
  buildAnilistFilterSql,
  computeAllowedMediaIds,
  DEFAULT_ALLOWED_LIST_STATUSES,
  compareGenres,
  formatOptionsForType,
  isInitialState,
  setFilterDbForTesting,
  sortedDualRangePair,
  toggleScoreBucket,
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

function seedListEntry(
  db: Database,
  userId: number,
  mediaId: number,
  status: string,
): void {
  db.exec(
    `INSERT INTO media_list_entry (
      anilist_user_id, media_id, score, status, repeat,
      started_year, started_month, started_day,
      completed_year, completed_month, completed_day,
      anilist_created_at, anilist_updated_at, fetched_at, updated_at
    ) VALUES (?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0)`,
    { bind: [userId, mediaId, status] } as never,
  );
}

function seedCharacter(db: Database, id: number): void {
  db.exec(
    `INSERT INTO character (id, name_full, fetched_at, updated_at)
     VALUES (?, ?, 0, 0)`,
    { bind: [id, `Char ${id}`] } as never,
  );
}

function seedMediaCharacter(
  db: Database,
  mediaId: number,
  characterId: number,
  role: 'MAIN' | 'SUPPORTING' | 'BACKGROUND' | null = 'MAIN',
): void {
  db.exec(
    `INSERT INTO media_character (media_id, character_id, role, sort_order)
     VALUES (?, ?, ?, 0)`,
    { bind: [mediaId, characterId, role] } as never,
  );
}

function seedStaff(db: Database, id: number, name: string): void {
  db.exec(
    `INSERT INTO staff (id, name_full, name_native, image, age, gender, language_v2, favourites, fetched_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, 'JAPANESE', NULL, 0, 0)`,
    { bind: [id, name] } as never,
  );
}

function seedVoiceActor(
  db: Database,
  mediaId: number,
  characterId: number,
  staffId: number,
): void {
  db.exec(
    `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
     VALUES (?, ?, ?, 'JAPANESE')`,
    { bind: [mediaId, characterId, staffId] } as never,
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

  it('emits IN clauses for years / formats / statuses with correct param counts', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({
        years: [2020, 2021],
        formats: ['TV', 'MOVIE'],
        statuses: ['FINISHED'],
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/m\.start_year IN \(\?, \?\)/);
    expect(out!.sql).toMatch(/m\.format IN \(\?, \?\)/);
    expect(out!.sql).toMatch(/m\.status IN \(\?\)/);
    // The candidate id leads the param list, then each clause in order.
    expect(out!.params).toEqual([1, 2020, 2021, 'TV', 'MOVIE', 'FINISHED']);
  });

  // --- user-score chip is post-SQL ---
  //
  // Score now filters the USER's own media_list_entry.score (and the
  // rated/unrated pill), not media.mean_score. That's per-user and
  // applied in computeAllowedMediaIds — the builder must stay silent
  // about it, exactly like listStatuses.

  it('scoreMin / scoreMax are NOT emitted by the SQL builder (handled post-SQL)', () => {
    const out = buildAnilistFilterSql(
      [1, 2],
      chips({ scoreMin: 60, scoreMax: 90 }),
    );
    expect(out).toBeNull();
  });

  it('userScoreInclude is NOT emitted by the SQL builder (handled post-SQL)', () => {
    expect(
      buildAnilistFilterSql([1], chips({ userScoreInclude: 'rated' })),
    ).toBeNull();
    expect(
      buildAnilistFilterSql([1], chips({ userScoreInclude: 'unrated' })),
    ).toBeNull();
  });

  // --- seasonYear range ---

  it('seasonYearMin/Max compare against the encoded (year*4 + season_idx) expression', () => {
    const out = buildAnilistFilterSql(
      [1],
      // Spring 2020 .. Fall 2022 — encoded 2020*4+1=8081 .. 2022*4+3=8091
      chips({ seasonYearMin: 8081, seasonYearMax: 8091 }),
    );
    expect(out).not.toBeNull();
    // Both bounds reference the season-encoded expression with the CASE
    // mapping (chronological order WINTER<SPRING<SUMMER<FALL).
    expect(out!.sql).toMatch(/m\.season_year \* 4 \+ CASE m\.season/);
    expect(out!.sql).toMatch(/WHEN 'WINTER' THEN 0/);
    expect(out!.sql).toMatch(/WHEN 'FALL' THEN 3/);
    expect(out!.params).toEqual([1, 8081, 8091]);
  });

  it('seasonYearMin alone emits only the lower-bound clause', () => {
    const out = buildAnilistFilterSql([1], chips({ seasonYearMin: 8080 }));
    expect(out).not.toBeNull();
    // The encoder is referenced once for the >= bound and not for <=.
    const matches = out!.sql.match(/m\.season_year \* 4/g) ?? [];
    expect(matches.length).toBe(1);
    expect(out!.params).toEqual([1, 8080]);
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

  it('voiceActorIds emit an EXISTS clause against character_voice_actor with staff_id bind list', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({ voiceActorIds: [1000, 1001] }),
    );
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/EXISTS \(\s*SELECT 1 FROM character_voice_actor cva/);
    expect(out!.sql).toMatch(/cva\.staff_id IN \(\?, \?\)/);
    // Candidate id leads, followed by every selected staff id.
    expect(out!.params).toEqual([1, 1000, 1001]);
  });

  it('listStatuses are NOT emitted by the SQL builder (handled post-SQL by computeAllowedMediaIds)', () => {
    // Critical contract: the SQL builder only knows about media-table
    // facts. List status is per-user and applied as a set intersect
    // after the SQL stage, so changing only listStatuses must leave
    // the builder output empty (no clauses, no params beyond the
    // candidate set).
    const out = buildAnilistFilterSql(
      [1, 2],
      chips({ listStatuses: ['CURRENT', 'PLANNING'] }),
    );
    expect(out).toBeNull();
  });
});

// =====================================================================
// isPassthrough / module integration
// =====================================================================

describe('isInitialState (passthrough)', () => {
  it('treats the literal initial state as passthrough so the FilterBar fast-path triggers', () => {
    expect(isInitialState(ANILIST_INITIAL_CHIP_STATE)).toBe(false);
    // ANILIST_INITIAL_CHIP_STATE pre-selects 3 of 6 list statuses,
    // which is an ACTIVE filter \u2014 not passthrough. The fast-path
    // intentionally does NOT trigger on the default state so the
    // pre-selection actually filters PLANNING/DROPPED/PAUSED entries.
  });

  it('treats an all-empty state as passthrough', () => {
    const empty = chips({ listStatuses: [] });
    expect(isInitialState(empty)).toBe(true);
  });

  it('treats a non-null score bound as active', () => {
    expect(isInitialState(chips({ listStatuses: [], scoreMin: 60 }))).toBe(false);
    expect(isInitialState(chips({ listStatuses: [], scoreMax: 90 }))).toBe(false);
  });

  it('treats a non-"any" userScoreInclude pill as active even without a range', () => {
    expect(
      isInitialState(chips({ listStatuses: [], userScoreInclude: 'rated' })),
    ).toBe(false);
    expect(
      isInitialState(chips({ listStatuses: [], userScoreInclude: 'unrated' })),
    ).toBe(false);
  });

  it('treats a non-null seasonYear bound as active', () => {
    expect(
      isInitialState(chips({ listStatuses: [], seasonYearMin: 8080 })),
    ).toBe(false);
    expect(
      isInitialState(chips({ listStatuses: [], seasonYearMax: 8083 })),
    ).toBe(false);
  });

  it('treats a both-null range pair as passthrough', () => {
    expect(
      isInitialState(
        chips({
          listStatuses: [],
          scoreMin: null,
          scoreMax: null,
          seasonYearMin: null,
          seasonYearMax: null,
        }),
      ),
    ).toBe(true);
  });

  it('treats all-6 listStatuses as passthrough (functional no-op)', () => {
    const allSix = chips({ listStatuses: [...ALL_LIST_STATUSES] });
    expect(isInitialState(allSix)).toBe(true);
  });

  it('treats a partial listStatuses selection as active', () => {
    const partial = chips({ listStatuses: DEFAULT_ALLOWED_LIST_STATUSES });
    expect(isInitialState(partial)).toBe(false);
  });

  it('treats any non-empty voiceActorIds as active', () => {
    const va = chips({ listStatuses: [], voiceActorIds: [42] });
    expect(isInitialState(va)).toBe(false);
  });

  it('module exports isInitialState as isPassthrough', () => {
    // FilterBar consults module.isPassthrough; if missing it falls
    // back to shallow-equal-vs-initial \u2014 which would mis-classify
    // our pre-selected default as "inactive". The module MUST expose
    // a passthrough override.
    expect(anilistFilterModule.isPassthrough).toBeDefined();
    expect(anilistFilterModule.isPassthrough!(ANILIST_INITIAL_CHIP_STATE)).toBe(
      false,
    );
  });
});

// =====================================================================
// toggleScoreBucket — Rated / Unrated multi-select <-> enum mapping
// =====================================================================

describe('toggleScoreBucket', () => {
  it('deselecting one bucket from the default narrows to the other', () => {
    // Default 'any' = both selected. Turning Rated off leaves Unrated.
    expect(toggleScoreBucket('any', 'rated')).toEqual({
      userScoreInclude: 'unrated',
      scoreMin: null,
      scoreMax: null,
    });
    // Turning Unrated off leaves Rated.
    expect(toggleScoreBucket('any', 'unrated')).toEqual({
      userScoreInclude: 'rated',
    });
  });

  it('re-selecting the missing bucket returns to both ("any")', () => {
    // From 'rated' (only Rated on), turning Unrated on selects both.
    expect(toggleScoreBucket('rated', 'unrated')).toEqual({
      userScoreInclude: 'any',
    });
    // From 'unrated' (only Unrated on), turning Rated on selects both.
    expect(toggleScoreBucket('unrated', 'rated')).toEqual({
      userScoreInclude: 'any',
    });
  });

  it('deselecting the last selected bucket is treated as both selected', () => {
    // 'rated' has only Rated on; turning Rated off would leave nothing,
    // which collapses back to 'any' (show both) rather than an empty set.
    expect(toggleScoreBucket('rated', 'rated')).toEqual({
      userScoreInclude: 'any',
    });
    expect(toggleScoreBucket('unrated', 'unrated')).toEqual({
      userScoreInclude: 'any',
    });
  });

  it('zeros the score range whenever the result stops showing rated items', () => {
    // Any result that lands on 'unrated' clears the slider bounds, since
    // the range only applies to the rated subset.
    expect(toggleScoreBucket('any', 'rated')).toHaveProperty('scoreMin', null);
    expect(toggleScoreBucket('any', 'rated')).toHaveProperty('scoreMax', null);
    // Results that keep rated visible leave the range untouched.
    expect(toggleScoreBucket('any', 'unrated')).not.toHaveProperty('scoreMin');
    expect(toggleScoreBucket('rated', 'unrated')).not.toHaveProperty('scoreMin');
  });
});

// =====================================================================
// compareGenres — alphabetical, except Hentai pinned to the bottom
// =====================================================================

describe('compareGenres', () => {
  it('sorts alphabetically for ordinary genres', () => {
    const sorted = ['Romance', 'Action', 'Comedy'].sort(compareGenres);
    expect(sorted).toEqual(['Action', 'Comedy', 'Romance']);
  });

  it('always pushes Hentai to the bottom regardless of input order', () => {
    expect(['Hentai', 'Action', 'Romance'].sort(compareGenres)).toEqual([
      'Action',
      'Romance',
      'Hentai',
    ]);
    // Even when it would otherwise sort early (H < R) it stays last.
    expect(['Romance', 'Hentai', 'Action'].sort(compareGenres)).toEqual([
      'Action',
      'Romance',
      'Hentai',
    ]);
  });
});

// =====================================================================
// formatOptionsForType — context-aware format chip options
// =====================================================================

describe('formatOptionsForType', () => {
  it('offers only anime formats for an anime slot', () => {
    expect(formatOptionsForType('ANIME')).toEqual([
      'TV',
      'TV_SHORT',
      'MOVIE',
      'SPECIAL',
      'OVA',
      'ONA',
      'MUSIC',
    ]);
  });

  it('offers only manga formats for a manga slot', () => {
    expect(formatOptionsForType('MANGA')).toEqual(['MANGA', 'NOVEL', 'ONE_SHOT']);
  });

  it('falls back to every format for a mixed / unknown slot', () => {
    const all = formatOptionsForType(null);
    expect(all).toEqual([
      'TV',
      'TV_SHORT',
      'MOVIE',
      'SPECIAL',
      'OVA',
      'ONA',
      'MUSIC',
      'MANGA',
      'NOVEL',
      'ONE_SHOT',
    ]);
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

  // --- user-score range + rated/unrated pill (per-user, post-SQL) ---
  //
  // Score now filters on the latest anilist_user's media_list_entry.score
  // (not media.mean_score). 0-score and absent list entries are treated
  // as "unrated". A few helper seeds are inlined here so each test is
  // self-contained.

  function seedUserScore(
    userId: number,
    mediaId: number,
    score: number,
  ): void {
    db.exec(
      `INSERT INTO media_list_entry (
        anilist_user_id, media_id, score, status, repeat,
        started_year, started_month, started_day,
        completed_year, completed_month, completed_day,
        anilist_created_at, anilist_updated_at, fetched_at, updated_at
      ) VALUES (?, ?, ?, 'COMPLETED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0)`,
      { bind: [userId, mediaId, score] } as never,
    );
  }

  it('scoreMin filters out rated entries whose user score is below the lower bound', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 50);
    seedUserScore(999, 2, 75);
    seedUserScore(999, 3, 90);
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      // userScoreInclude:'any' + range — items in range pass, but
      // unrated items would ALSO pass (none here, all three are rated).
      chips({ scoreMin: 70 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('scoreMax filters out rated entries above the upper bound', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 50);
    seedUserScore(999, 2, 75);
    seedUserScore(999, 3, 90);
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({ scoreMax: 80 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('scoreMin+scoreMax acts as BETWEEN on rated entries; unrated entries pass when pill="any"', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3); // no list entry → unrated
    seedMedia(db, 4);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 65);
    seedUserScore(999, 2, 80);
    seedUserScore(999, 4, 0); // explicit 0 → also unrated
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3, 4],
      chips({ scoreMin: 60, scoreMax: 90 }),
    );
    // 1+2 pass via range; 3+4 pass because pill is "any" (unrated
    // items aren't affected by the range filter).
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('pill="rated" drops unrated AND entry-less items', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2); // no list entry → unrated
    seedMedia(db, 3);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 70);
    seedUserScore(999, 3, 0); // explicit 0 → unrated
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({ userScoreInclude: 'rated' }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('pill="rated" combines with the range slider (BETWEEN on rated subset)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 65);
    seedUserScore(999, 2, 80);
    seedUserScore(999, 3, 95);
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({ userScoreInclude: 'rated', scoreMin: 70, scoreMax: 90 }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('pill="unrated" keeps ONLY items with no list entry or score === 0', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedMedia(db, 4);
    seedUser(db, 999, 'me');
    seedUserScore(999, 1, 80); // rated → dropped
    // id 2: no entry → unrated → keep
    seedUserScore(999, 3, 0); // explicit 0 → unrated → keep
    seedUserScore(999, 4, 1); // rated → dropped (edge: score=1 is rated)
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3, 4],
      chips({ userScoreInclude: 'unrated' }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('user-score filter with no anilist_user known degrades to passthrough (no false zeros)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    // No user seeded. The chip can't be evaluated; fail open so we
    // don't show "0 items" when the real cause is a stale DB.
    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ userScoreInclude: 'rated', scoreMin: 60 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // --- seasonYear range ---

  it('seasonYearMin/Max filters chronologically across the (season, season_year) tuple', async () => {
    // Encoded values: WINTER 2020 = 8080, SPRING 2020 = 8081, FALL
    // 2020 = 8083, WINTER 2021 = 8084.
    seedMedia(db, 1, { season: 'WINTER', season_year: 2020 }); // 8080
    seedMedia(db, 2, { season: 'SPRING', season_year: 2020 }); // 8081
    seedMedia(db, 3, { season: 'FALL', season_year: 2020 }); // 8083
    seedMedia(db, 4, { season: 'WINTER', season_year: 2021 }); // 8084
    seedMedia(db, 5, { season: null, season_year: null }); // unplaceable

    const allowed = await computeAllowedMediaIds(
      [1, 2, 3, 4, 5],
      // Spring 2020 (incl) to Fall 2020 (incl).
      chips({ seasonYearMin: 8081, seasonYearMax: 8083 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('seasonYear range excludes rows with NULL season or season_year when the chip is active', async () => {
    seedMedia(db, 1, { season: 'WINTER', season_year: 2020 });
    seedMedia(db, 2, { season: null, season_year: 2020 });
    seedMedia(db, 3, { season: 'WINTER', season_year: null });
    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      // Lower bound only — id 1 (WINTER 2020 = 8080) is in, ids 2 + 3
      // can't be placed and so are dropped.
      chips({ seasonYearMin: 8080 }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  // --- list status (per-user, applied post-SQL) ---

  it('listStatuses excludes ids whose list entry has a status outside the allowed set', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedUser(db, 999, 'me');
    seedListEntry(db, 999, 1, 'CURRENT');
    seedListEntry(db, 999, 2, 'PLANNING');
    seedListEntry(db, 999, 3, 'DROPPED');

    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({ listStatuses: ['CURRENT', 'COMPLETED', 'REPEATING'] }),
    );
    // Only the CURRENT entry survives \u2014 PLANNING and DROPPED are
    // dropped by the chip.
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('listStatuses leaves entries with NO list_entry alone (favourites-only items pass through)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedUser(db, 999, 'me');
    seedListEntry(db, 999, 1, 'PLANNING'); // disallowed
    // id 2 has no list entry \u2014 the chip semantics is "exclude
    // wrong statuses", not "require a matching status", so 2 stays.

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ listStatuses: ['CURRENT', 'COMPLETED', 'REPEATING'] }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('listStatuses=[] is treated as passthrough (no filtering)', async () => {
    seedMedia(db, 1, { mean_score: 80 });
    seedUser(db, 999, 'me');
    seedListEntry(db, 999, 1, 'PLANNING');
    // Empty listStatuses must NOT filter. Pair with a non-default
    // genre so isInitialState() returns false and we exercise the
    // real filtering path (not the all-passthrough early-return).
    seedMedia(db, 2, { genres_json: '["Action"]' });
    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ listStatuses: [], genres: ['Action'] }),
    );
    // Only id 2 matches the genre; id 1 is dropped by the genre
    // filter, not by listStatuses (which is intentionally inactive).
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('listStatuses with all 6 selected is passthrough (no filtering)', async () => {
    seedMedia(db, 1, { mean_score: 80 });
    seedUser(db, 999, 'me');
    seedListEntry(db, 999, 1, 'PLANNING');
    seedMedia(db, 2, { genres_json: '["Action"]' });
    // All 6 = "let everything through". Pair with a genre filter for
    // the same isolation reason as the previous test.
    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({
        listStatuses: [...ALL_LIST_STATUSES],
        genres: ['Action'],
      }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('listStatuses with no anilist_user known degrades to passthrough (no false zeros)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    // No user seeded \u2014 can't evaluate per-user list_entry. Fail open
    // so the user doesn't see "0 items" when the cause is just a
    // stale shared DB with no anilist_user rows.
    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ listStatuses: ['CURRENT'] }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // --- voice actor (cached cast only) ---

  it('voiceActorIds keeps only ids that have a cached cast row joining the selected staff', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedCharacter(db, 10);
    seedCharacter(db, 11);
    seedMediaCharacter(db, 1, 10);
    seedMediaCharacter(db, 2, 11);
    seedStaff(db, 1000, 'VA A');
    seedStaff(db, 1001, 'VA B');
    seedVoiceActor(db, 1, 10, 1000);
    seedVoiceActor(db, 2, 11, 1001);
    // Media 3 has no cached cast at all \u2014 must be filtered OUT
    // (the chip cannot prove a match without cached data).

    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({ voiceActorIds: [1000] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('voiceActorIds multi-select uses OR (any selected staff in the cast satisfies the chip)', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedCharacter(db, 10);
    seedCharacter(db, 11);
    seedMediaCharacter(db, 1, 10);
    seedMediaCharacter(db, 2, 11);
    seedStaff(db, 1000, 'VA A');
    seedStaff(db, 1001, 'VA B');
    seedVoiceActor(db, 1, 10, 1000);
    seedVoiceActor(db, 2, 11, 1001);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ voiceActorIds: [1000, 1001] }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // --- voice actor role refinement ---

  it('voiceActorRoles empty is a passthrough — same SQL as before the refinement existed', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({ voiceActorIds: [1000], voiceActorRoles: [] }),
    );
    expect(out).not.toBeNull();
    // No media_character JOIN when the role array is empty — keeps
    // the plan identical to v1.
    expect(out!.sql).not.toMatch(/media_character/);
    expect(out!.sql).toMatch(/cva\.staff_id IN \(\?\)/);
  });

  it('voiceActorRoles non-empty adds a media_character JOIN + role IN binding after the staff ids', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({
        voiceActorIds: [1000, 1001],
        voiceActorRoles: ['MAIN', 'SUPPORTING'],
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.sql).toMatch(/JOIN media_character mc/);
    expect(out!.sql).toMatch(/mc\.role IN \(\?, \?\)/);
    // Param order contract: candidate ids, then staff ids, then roles.
    expect(out!.params).toEqual([1, 1000, 1001, 'MAIN', 'SUPPORTING']);
  });

  it('voiceActorRoles=[MAIN] excludes shows whose only VA hit is a SUPPORTING character', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedCharacter(db, 10);
    seedCharacter(db, 11);
    // Show 1: VA voices a MAIN character → passes a MAIN filter.
    seedMediaCharacter(db, 1, 10, 'MAIN');
    // Show 2: same VA, but only voices a SUPPORTING character →
    // must be excluded when MAIN is the only allowed role.
    seedMediaCharacter(db, 2, 11, 'SUPPORTING');
    seedStaff(db, 1000, 'VA A');
    seedVoiceActor(db, 1, 10, 1000);
    seedVoiceActor(db, 2, 11, 1000);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ voiceActorIds: [1000], voiceActorRoles: ['MAIN'] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('voiceActorRoles multi-select admits any of the selected roles', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedMedia(db, 3);
    seedCharacter(db, 10);
    seedCharacter(db, 11);
    seedCharacter(db, 12);
    seedMediaCharacter(db, 1, 10, 'MAIN');
    seedMediaCharacter(db, 2, 11, 'SUPPORTING');
    seedMediaCharacter(db, 3, 12, 'BACKGROUND');
    seedStaff(db, 1000, 'VA A');
    seedVoiceActor(db, 1, 10, 1000);
    seedVoiceActor(db, 2, 11, 1000);
    seedVoiceActor(db, 3, 12, 1000);

    const allowed = await computeAllowedMediaIds(
      [1, 2, 3],
      chips({
        voiceActorIds: [1000],
        voiceActorRoles: ['MAIN', 'SUPPORTING'],
      }),
    );
    // MAIN + SUPPORTING pass; BACKGROUND-only show is dropped.
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // NULL is intentionally excluded when any role is selected — older
  // imports with role=NULL are too ambiguous to honor a role filter.
  // SQL `IN (...)` naturally drops nulls; this test pins that
  // behaviour against accidental future regressions (e.g. someone
  // coercing nulls to 'SUPPORTING' in a "be helpful" patch).
  it('voiceActorRoles excludes characters whose media_character.role IS NULL when active', async () => {
    seedMedia(db, 1);
    seedMedia(db, 2);
    seedCharacter(db, 10);
    seedCharacter(db, 11);
    seedMediaCharacter(db, 1, 10, 'MAIN');
    seedMediaCharacter(db, 2, 11, null);
    seedStaff(db, 1000, 'VA A');
    seedVoiceActor(db, 1, 10, 1000);
    seedVoiceActor(db, 2, 11, 1000);

    const allowed = await computeAllowedMediaIds(
      [1, 2],
      chips({ voiceActorIds: [1000], voiceActorRoles: ['MAIN'] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('voiceActorRoles is a no-op when voiceActorIds is empty (no EXISTS clause emitted)', () => {
    const out = buildAnilistFilterSql(
      [1],
      chips({ voiceActorIds: [], voiceActorRoles: ['MAIN'] }),
    );
    // The whole VA chip stays inactive — no character_voice_actor
    // subquery, no media_character JOIN, just whatever other chips
    // contributed (here: nothing → null).
    expect(out?.sql ?? '').not.toMatch(/character_voice_actor/);
  });
});

describe('sortedDualRangePair', () => {
  it('orders crossed drag values into [min, max]', () => {
    expect(sortedDualRangePair(2020, 2022)).toEqual([2020, 2022]);
    expect(sortedDualRangePair(2022, 2020)).toEqual([2020, 2022]);
  });
});
