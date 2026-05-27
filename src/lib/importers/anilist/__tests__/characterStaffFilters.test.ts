/**
 * Filter chip modules for character + staff favourites. Covers
 *   - characterIsInitialState / staffIsInitialState as pure functions
 *     (the FilterBar's fast-path passthrough switch).
 *   - computeAllowedCharacterIds / computeAllowedStaffIds end-to-end
 *     against an in-memory anilist.sqlite so the SQL they emit
 *     actually runs and filters correctly.
 *
 * Same db-injection seam as the media filter tests
 * (`setCharacterStaffFilterDbForTesting`) so the chip code reaches
 * the in-memory db without going through the worker layer.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../../db/__tests__/testSqlite';
import { migrate } from '../../../db/migration-runner';
import { anilistSourceDescriptor } from '../anilistSource';
import type { AnilistDbExecutor } from '../context';
import {
  CHARACTER_INITIAL_CHIP_STATE,
  STAFF_INITIAL_CHIP_STATE,
  characterIsInitialState,
  characterFilterModule,
  computeAllowedCharacterIds,
  computeAllowedStaffIds,
  setCharacterStaffFilterDbForTesting,
  staffIsInitialState,
  staffFilterModule,
  type CharacterFilterChipState,
  type StaffFilterChipState,
} from '../characterStaffFilters';

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

function charChips(
  patch: Partial<CharacterFilterChipState>,
): CharacterFilterChipState {
  return { ...CHARACTER_INITIAL_CHIP_STATE, ...patch };
}

function staffChips(
  patch: Partial<StaffFilterChipState>,
): StaffFilterChipState {
  return { ...STAFF_INITIAL_CHIP_STATE, ...patch };
}

// ---------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------

function seedCharacter(
  db: Database,
  id: number,
  o: Partial<{
    name_full: string | null;
    name_native: string | null;
    gender: string | null;
    favourites: number | null;
  }> = {},
): void {
  const row = {
    name_full: `Char ${id}`,
    name_native: null as string | null,
    gender: null as string | null,
    favourites: null as number | null,
    ...o,
  };
  db.exec(
    `INSERT INTO character (
      id, name_full, name_native, name_alternatives_json,
      name_alternatives_spoiler_json, image, age, gender, favourites,
      fetched_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, 0)`,
    {
      bind: [id, row.name_full, row.name_native, row.gender, row.favourites],
    } as never,
  );
}

function seedStaff(
  db: Database,
  id: number,
  o: Partial<{
    name_full: string | null;
    name_native: string | null;
    gender: string | null;
    language_v2: string | null;
    favourites: number | null;
  }> = {},
): void {
  const row = {
    name_full: `Staff ${id}`,
    name_native: null as string | null,
    gender: null as string | null,
    language_v2: 'JAPANESE' as string | null,
    favourites: null as number | null,
    ...o,
  };
  db.exec(
    `INSERT INTO staff (
      id, name_full, name_native, image, age, gender, language_v2,
      favourites, fetched_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 0, 0)`,
    {
      bind: [
        id,
        row.name_full,
        row.name_native,
        row.gender,
        row.language_v2,
        row.favourites,
      ],
    } as never,
  );
}

function seedMedia(db: Database, id: number, title: string | null = null): void {
  db.exec(
    `INSERT INTO media (
      id, type, title_english, title_romaji, title_native, cover_image,
      format, status, episodes, chapters, start_year, start_month, start_day,
      end_year, end_month, end_day, season, season_year, mean_score, favourites,
      country_of_origin, genres_json, synonyms_json, fetched_at, updated_at
    ) VALUES (?, 'ANIME', NULL, ?, NULL, NULL, 'TV', 'FINISHED',
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, '[]', NULL, 0, 0)`,
    { bind: [id, title ?? `Media ${id}`] } as never,
  );
}

function seedMediaCharacter(
  db: Database,
  mediaId: number,
  characterId: number,
  role: string,
): void {
  db.exec(
    `INSERT INTO media_character (media_id, character_id, role, sort_order)
     VALUES (?, ?, ?, 0)`,
    { bind: [mediaId, characterId, role] } as never,
  );
}

function seedVoiceActor(
  db: Database,
  mediaId: number,
  characterId: number,
  staffId: number,
  language: string = 'JAPANESE',
): void {
  db.exec(
    `INSERT INTO character_voice_actor (media_id, character_id, staff_id, language)
     VALUES (?, ?, ?, ?)`,
    { bind: [mediaId, characterId, staffId, language] } as never,
  );
}

/** `fetched_at` defaults to 0 — pass a higher value to force a
 *  particular user to be "latest" per `getLatestAnilistUser`'s
 *  `ORDER BY fetched_at DESC` (used by tests that seed multiple users
 *  and need a deterministic winner). */
function seedAnilistUser(
  db: Database,
  id: number,
  name: string,
  fetchedAt: number = 0,
): void {
  db.exec(
    `INSERT INTO anilist_user (id, name, fetched_at, updated_at)
     VALUES (?, ?, ?, 0)`,
    { bind: [id, name, fetchedAt] } as never,
  );
}

/** sortOrder is 0-indexed (matches AniList's `favouriteOrder` and the
 *  raw column value). The chip's UI / filter range works in 1-indexed
 *  ranks — `getFavouriteRanksForIds` does the +1 once, in one place. */
function seedCharacterFavourite(
  db: Database,
  anilistUserId: number,
  characterId: number,
  sortOrder: number,
): void {
  db.exec(
    `INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at)
     VALUES (?, ?, ?, 0)`,
    { bind: [anilistUserId, characterId, sortOrder] } as never,
  );
}

function seedStaffFavourite(
  db: Database,
  anilistUserId: number,
  staffId: number,
  sortOrder: number,
): void {
  db.exec(
    `INSERT INTO staff_favourite (anilist_user_id, staff_id, sort_order, fetched_at)
     VALUES (?, ?, ?, 0)`,
    { bind: [anilistUserId, staffId, sortOrder] } as never,
  );
}

// =====================================================================
// Initial-state / passthrough
// =====================================================================

describe('characterIsInitialState', () => {
  it('the canonical empty state is passthrough', () => {
    expect(characterIsInitialState(CHARACTER_INITIAL_CHIP_STATE)).toBe(true);
  });

  it('any active chip flips to non-passthrough', () => {
    expect(characterIsInitialState(charChips({ genders: ['Female'] }))).toBe(false);
    expect(characterIsInitialState(charChips({ favouritesMin: 100 }))).toBe(false);
    expect(characterIsInitialState(charChips({ favouritesMax: 1000 }))).toBe(false);
    expect(characterIsInitialState(charChips({ favouriteRankMin: 1 }))).toBe(false);
    expect(characterIsInitialState(charChips({ favouriteRankMax: 50 }))).toBe(false);
    expect(characterIsInitialState(charChips({ appearsInMediaIds: [1] }))).toBe(false);
    expect(characterIsInitialState(charChips({ voiceActorIds: [1] }))).toBe(false);
  });

  it('isPassthrough on the module mirrors characterIsInitialState', () => {
    expect(characterFilterModule.isPassthrough!(CHARACTER_INITIAL_CHIP_STATE)).toBe(true);
    expect(characterFilterModule.isPassthrough!(charChips({ genders: ['Male'] }))).toBe(false);
  });
});

describe('staffIsInitialState', () => {
  it('the canonical empty state is passthrough', () => {
    expect(staffIsInitialState(STAFF_INITIAL_CHIP_STATE)).toBe(true);
  });

  it('any active chip flips to non-passthrough', () => {
    expect(staffIsInitialState(staffChips({ genders: ['Female'] }))).toBe(false);
    expect(staffIsInitialState(staffChips({ favouritesMin: 50 }))).toBe(false);
    expect(staffIsInitialState(staffChips({ favouriteRankMin: 1 }))).toBe(false);
    expect(staffIsInitialState(staffChips({ favouriteRankMax: 25 }))).toBe(false);
    expect(staffIsInitialState(staffChips({ languages: ['JAPANESE'] }))).toBe(false);
    expect(staffIsInitialState(staffChips({ voicedInMediaIds: [1] }))).toBe(false);
  });

  it('isPassthrough on the module mirrors staffIsInitialState', () => {
    expect(staffFilterModule.isPassthrough!(STAFF_INITIAL_CHIP_STATE)).toBe(true);
    expect(staffFilterModule.isPassthrough!(staffChips({ languages: ['JAPANESE'] }))).toBe(false);
  });
});

// =====================================================================
// computeAllowedCharacterIds
// =====================================================================

describe('computeAllowedCharacterIds', () => {
  let db: Database;
  beforeEach(async () => {
    db = await freshAnilistDb();
    setCharacterStaffFilterDbForTesting(makeDbAdapter(db));
  });
  afterEach(() => {
    setCharacterStaffFilterDbForTesting(null);
    db.close();
  });

  it('empty input → empty output (skips SQL)', async () => {
    const allowed = await computeAllowedCharacterIds([], charChips({ genders: ['Male'] }));
    expect(allowed.size).toBe(0);
  });

  it('passthrough state lets every candidate through (no SQL)', async () => {
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      CHARACTER_INITIAL_CHIP_STATE,
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  // --- gender chip ---

  it('genders chip filters by exact gender match', async () => {
    seedCharacter(db, 1, { gender: 'Male' });
    seedCharacter(db, 2, { gender: 'Female' });
    seedCharacter(db, 3, { gender: 'Non-binary' });
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ genders: ['Female'] }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('(unknown) gender bucket matches BOTH null and the literal "Unknown"', async () => {
    seedCharacter(db, 1, { gender: null });
    seedCharacter(db, 2, { gender: 'Unknown' });
    seedCharacter(db, 3, { gender: 'Male' });
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ genders: ['(unknown)'] }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // --- favourites range ---

  it('favouritesMin filters out rows below the lower bound', async () => {
    seedCharacter(db, 1, { favourites: 100 });
    seedCharacter(db, 2, { favourites: 500 });
    seedCharacter(db, 3, { favourites: 1000 });
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ favouritesMin: 200 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('favouritesMax filters out rows above the upper bound', async () => {
    seedCharacter(db, 1, { favourites: 100 });
    seedCharacter(db, 2, { favourites: 500 });
    seedCharacter(db, 3, { favourites: 1000 });
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ favouritesMax: 600 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('favourites range drops rows with NULL favourites (no count → not in any range)', async () => {
    seedCharacter(db, 1, { favourites: 200 });
    seedCharacter(db, 2, { favourites: null });
    const allowed = await computeAllowedCharacterIds(
      [1, 2],
      charChips({ favouritesMin: 100 }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  // --- appears-in-media chip (junction-driven, phase 2) ---

  it('appearsInMediaIds keeps characters appearing in at least one selected media', async () => {
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedMedia(db, 100);
    seedMedia(db, 200);
    seedMediaCharacter(db, 100, 1, 'MAIN');
    seedMediaCharacter(db, 200, 2, 'MAIN');
    const allowed = await computeAllowedCharacterIds(
      [1, 2],
      charChips({ appearsInMediaIds: [100] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('appearsInMediaIds with no cached junction drops everything (no fallback to passthrough)', async () => {
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    const allowed = await computeAllowedCharacterIds(
      [1, 2],
      charChips({ appearsInMediaIds: [100] }),
    );
    expect(allowed.size).toBe(0);
  });

  // --- voice-actor chip (junction-driven, phase 2) ---

  it('voiceActorIds keeps characters voiced by at least one selected staff (any language)', async () => {
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedMedia(db, 100);
    seedStaff(db, 9000);
    // character_voice_actor has a composite FK to media_character —
    // seed the appearance row first.
    seedMediaCharacter(db, 100, 1, 'MAIN');
    seedVoiceActor(db, 100, 1, 9000, 'JAPANESE');
    // id 2 has no voice-actor row → dropped
    const allowed = await computeAllowedCharacterIds(
      [1, 2],
      charChips({ voiceActorIds: [9000] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  // --- combinations ---

  it('multiple active chips intersect (gender AND appearsInMediaIds)', async () => {
    seedCharacter(db, 1, { gender: 'Female' });
    seedCharacter(db, 2, { gender: 'Female' });
    seedCharacter(db, 3, { gender: 'Male' });
    seedMedia(db, 100);
    seedMedia(db, 200);
    seedMediaCharacter(db, 100, 1, 'MAIN');
    seedMediaCharacter(db, 200, 2, 'MAIN'); // wrong media
    seedMediaCharacter(db, 100, 3, 'MAIN'); // wrong gender
    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ genders: ['Female'], appearsInMediaIds: [100] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });
});

// =====================================================================
// computeAllowedStaffIds
// =====================================================================

describe('computeAllowedStaffIds', () => {
  let db: Database;
  beforeEach(async () => {
    db = await freshAnilistDb();
    setCharacterStaffFilterDbForTesting(makeDbAdapter(db));
  });
  afterEach(() => {
    setCharacterStaffFilterDbForTesting(null);
    db.close();
  });

  it('empty input → empty output', async () => {
    const allowed = await computeAllowedStaffIds(
      [],
      staffChips({ genders: ['Male'] }),
    );
    expect(allowed.size).toBe(0);
  });

  it('passthrough state lets every candidate through', async () => {
    const allowed = await computeAllowedStaffIds(
      [1, 2, 3],
      STAFF_INITIAL_CHIP_STATE,
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('genders chip filters by exact gender match', async () => {
    seedStaff(db, 1, { gender: 'Male' });
    seedStaff(db, 2, { gender: 'Female' });
    seedStaff(db, 3, { gender: null });
    const allowed = await computeAllowedStaffIds(
      [1, 2, 3],
      staffChips({ genders: ['Female'] }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('language chip filters by language_v2 (with (unknown) bucket for null/empty)', async () => {
    seedStaff(db, 1, { language_v2: 'JAPANESE' });
    seedStaff(db, 2, { language_v2: 'ENGLISH' });
    seedStaff(db, 3, { language_v2: null });
    seedStaff(db, 4, { language_v2: '' });

    const justJapanese = await computeAllowedStaffIds(
      [1, 2, 3, 4],
      staffChips({ languages: ['JAPANESE'] }),
    );
    expect(Array.from(justJapanese)).toEqual([1]);

    const justUnknown = await computeAllowedStaffIds(
      [1, 2, 3, 4],
      staffChips({ languages: ['(unknown)'] }),
    );
    expect(Array.from(justUnknown).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it('favourites range works the same way as on characters', async () => {
    seedStaff(db, 1, { favourites: 100 });
    seedStaff(db, 2, { favourites: 500 });
    seedStaff(db, 3, { favourites: null });
    const allowed = await computeAllowedStaffIds(
      [1, 2, 3],
      staffChips({ favouritesMin: 200, favouritesMax: 800 }),
    );
    expect(Array.from(allowed)).toEqual([2]);
  });

  it('voicedInMediaIds keeps staff who voice a character in at least one selected media', async () => {
    seedStaff(db, 1);
    seedStaff(db, 2);
    seedCharacter(db, 50);
    seedMedia(db, 100);
    seedMedia(db, 200);
    seedMediaCharacter(db, 100, 50, 'MAIN');
    seedMediaCharacter(db, 200, 50, 'SUPPORTING');
    seedVoiceActor(db, 100, 50, 1, 'JAPANESE');
    seedVoiceActor(db, 200, 50, 2, 'ENGLISH');
    const allowed = await computeAllowedStaffIds(
      [1, 2],
      staffChips({ voicedInMediaIds: [100] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('voicedInMediaIds with empty junction drops everything (no silent passthrough)', async () => {
    seedStaff(db, 1);
    seedStaff(db, 2);
    const allowed = await computeAllowedStaffIds(
      [1, 2],
      staffChips({ voicedInMediaIds: [100] }),
    );
    expect(allowed.size).toBe(0);
  });

  it('multiple chips intersect (gender AND language)', async () => {
    seedStaff(db, 1, { gender: 'Female', language_v2: 'JAPANESE' });
    seedStaff(db, 2, { gender: 'Female', language_v2: 'ENGLISH' });
    seedStaff(db, 3, { gender: 'Male', language_v2: 'JAPANESE' });
    const allowed = await computeAllowedStaffIds(
      [1, 2, 3],
      staffChips({ genders: ['Female'], languages: ['JAPANESE'] }),
    );
    expect(Array.from(allowed)).toEqual([1]);
  });
});

// =====================================================================
// favourite-rank chip — covers the strict "items not in favourites are
// dropped when the chip is active" semantics for both modules, plus
// the fail-open guard for the no-user case.
// =====================================================================

describe('favourite-rank filter (characters)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await freshAnilistDb();
    setCharacterStaffFilterDbForTesting(makeDbAdapter(db));
  });
  afterEach(() => {
    setCharacterStaffFilterDbForTesting(null);
    db.close();
  });

  it('top-X: rankMax slices the first N favourites; non-favourites are dropped', async () => {
    seedAnilistUser(db, 7, 'me');
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedCharacter(db, 3);
    seedCharacter(db, 4);
    // candidate 1 = rank 1, candidate 2 = rank 2, candidate 3 = rank 3,
    // candidate 4 is NOT in the favourites table at all.
    seedCharacterFavourite(db, 7, 1, 0);
    seedCharacterFavourite(db, 7, 2, 1);
    seedCharacterFavourite(db, 7, 3, 2);

    const top2 = await computeAllowedCharacterIds(
      [1, 2, 3, 4],
      charChips({ favouriteRankMax: 2 }),
    );
    // 1 (rank 1) and 2 (rank 2) pass; 3 (rank 3) is past the cutoff;
    // 4 is not a favourite → strict drop.
    expect(Array.from(top2).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('mid-range: rankMin AND rankMax slice a window (e.g. ranks 2..3)', async () => {
    seedAnilistUser(db, 7, 'me');
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedCharacter(db, 3);
    seedCharacter(db, 4);
    seedCharacterFavourite(db, 7, 1, 0); // rank 1
    seedCharacterFavourite(db, 7, 2, 1); // rank 2
    seedCharacterFavourite(db, 7, 3, 2); // rank 3
    seedCharacterFavourite(db, 7, 4, 3); // rank 4

    const window = await computeAllowedCharacterIds(
      [1, 2, 3, 4],
      charChips({ favouriteRankMin: 2, favouriteRankMax: 3 }),
    );
    expect(Array.from(window).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('strict semantics: a non-favourited candidate is dropped even when the rank range would otherwise be a no-op (just rankMin=1)', async () => {
    seedAnilistUser(db, 7, 'me');
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedCharacterFavourite(db, 7, 1, 0);
    // id 2 is NOT in favourites.

    const allowed = await computeAllowedCharacterIds(
      [1, 2],
      charChips({ favouriteRankMin: 1 }),
    );
    // Active chip → strict drop of non-favourites, even though no
    // upper bound means "no rank limit".
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('fails OPEN when no anilist_user is cached (same as listStatuses / user-score)', async () => {
    // No seedAnilistUser call → getLatestAnilistUser returns null.
    seedCharacter(db, 1);
    seedCharacter(db, 2);
    seedCharacter(db, 3);

    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ favouriteRankMax: 1 }),
    );
    // Without a user we can't score anything — pass everything through
    // rather than silently producing 0 rows.
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('uses the LATEST cached anilist_user when multiple exist (matches listStatuses behaviour)', async () => {
    // `getLatestAnilistUser` resolves by `ORDER BY fetched_at DESC`,
    // not by id — bump the second user's timestamp so the test is
    // deterministic regardless of insert order.
    seedAnilistUser(db, 1, 'olduser', 100);
    seedAnilistUser(db, 2, 'newuser', 200);
    seedCharacter(db, 10);
    seedCharacter(db, 20);
    seedCharacterFavourite(db, 1, 10, 0); // user 1's #1
    seedCharacterFavourite(db, 2, 20, 0); // user 2's #1

    const allowed = await computeAllowedCharacterIds(
      [10, 20],
      charChips({ favouriteRankMax: 1 }),
    );
    expect(Array.from(allowed)).toEqual([20]);
  });

  it('combines correctly with gender (intersection)', async () => {
    seedAnilistUser(db, 7, 'me');
    seedCharacter(db, 1, { gender: 'Female' });
    seedCharacter(db, 2, { gender: 'Male' });
    seedCharacter(db, 3, { gender: 'Female' });
    seedCharacterFavourite(db, 7, 1, 0); // rank 1, Female
    seedCharacterFavourite(db, 7, 2, 1); // rank 2, Male
    seedCharacterFavourite(db, 7, 3, 2); // rank 3, Female

    const allowed = await computeAllowedCharacterIds(
      [1, 2, 3],
      charChips({ genders: ['Female'], favouriteRankMax: 2 }),
    );
    // Female AND in top 2 favourites → only id 1.
    expect(Array.from(allowed)).toEqual([1]);
  });
});

describe('favourite-rank filter (staff)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await freshAnilistDb();
    setCharacterStaffFilterDbForTesting(makeDbAdapter(db));
  });
  afterEach(() => {
    setCharacterStaffFilterDbForTesting(null);
    db.close();
  });

  it('top-X: rankMax slices the first N favourite staff; non-favourites dropped', async () => {
    seedAnilistUser(db, 7, 'me');
    seedStaff(db, 1);
    seedStaff(db, 2);
    seedStaff(db, 3);
    seedStaffFavourite(db, 7, 1, 0);
    seedStaffFavourite(db, 7, 2, 1);
    // id 3 is NOT a favourite.

    const top1 = await computeAllowedStaffIds(
      [1, 2, 3],
      staffChips({ favouriteRankMax: 1 }),
    );
    expect(Array.from(top1)).toEqual([1]);
  });

  it('combines with language (intersection)', async () => {
    seedAnilistUser(db, 7, 'me');
    seedStaff(db, 1, { language_v2: 'JAPANESE' });
    seedStaff(db, 2, { language_v2: 'ENGLISH' });
    seedStaff(db, 3, { language_v2: 'JAPANESE' });
    seedStaffFavourite(db, 7, 1, 0); // rank 1
    seedStaffFavourite(db, 7, 2, 1); // rank 2
    seedStaffFavourite(db, 7, 3, 2); // rank 3

    const allowed = await computeAllowedStaffIds(
      [1, 2, 3],
      staffChips({ languages: ['JAPANESE'], favouriteRankMax: 2 }),
    );
    // Japanese AND in top 2 → only id 1 (id 3 is Japanese but rank 3).
    expect(Array.from(allowed)).toEqual([1]);
  });

  it('fails open when no anilist_user is cached', async () => {
    seedStaff(db, 1);
    seedStaff(db, 2);
    const allowed = await computeAllowedStaffIds(
      [1, 2],
      staffChips({ favouriteRankMax: 1 }),
    );
    expect(Array.from(allowed).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
