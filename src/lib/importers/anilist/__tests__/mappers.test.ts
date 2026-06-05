import { describe, expect, it } from 'vitest';
import type {
  AnilistCharacterGql,
  AnilistFavouriteEdge,
  AnilistFuzzyDate,
  AnilistMediaCharacterEdgeGql,
  AnilistMediaGql,
  AnilistMediaListEntryGql,
  AnilistStaffGql,
} from '../types';
import {
  collectCustomListIdentities,
  mapAnilistUserRow,
  mapCharacterFavouriteRow,
  mapCharacterRow,
  mapCharacterVoiceActorRows,
  mapMediaCharacterRows,
  mapMediaFavouriteRow,
  mapMediaListEntryRow,
  mapMediaRow,
  mapMediaStudioRows,
  mapMediaTagRows,
  mapStaffCharacterAppearanceData,
  mapStaffFilmographyMediaStaffRows,
  mapStaffFavouriteRow,
  mapStaffRow,
  mapStudioFavouriteRow,
  mapStudioRows,
  mapTagRows,
} from '../mappers';

const NOW = 1_700_000_000_000;
// Stable mock AniList User.id used everywhere a user dimension is
// needed; matches the safe-character convention for opaque IDs.
const USER_ID = 12345;

function fuzzy(year: number | null, month: number | null, day: number | null): AnilistFuzzyDate {
  return { year, month, day };
}

function fullMedia(overrides: Partial<AnilistMediaGql> = {}): AnilistMediaGql {
  return {
    id: 100,
    type: 'ANIME',
    title: { english: 'EN', romaji: 'RO', native: 'NA' },
    coverImage: { large: 'https://example.test/cover.jpg' },
    format: 'TV',
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    startDate: fuzzy(2020, 1, 5),
    endDate: fuzzy(2020, 3, 28),
    season: 'WINTER',
    seasonYear: 2020,
    meanScore: 78,
    favourites: 1234,
    countryOfOrigin: 'JP',
    genres: ['Romance', 'Slice of Life'],
    synonyms: ['Test Alt Title'],
    studios: { nodes: [{ id: 10, name: 'A-1 Pictures' }, { id: 11, name: 'CloverWorks' }] },
    tags: [{ name: 'Romance', rank: 90 }, { name: 'School', rank: 70 }],
    ...overrides,
  };
}

function fullEntry(overrides: Partial<AnilistMediaListEntryGql> = {}): AnilistMediaListEntryGql {
  return {
    score: 88,
    status: 'COMPLETED',
    repeat: null,
    startedAt: null,
    completedAt: null,
    createdAt: null,
    updatedAt: null,
    customLists: [],
    media: fullMedia(),
    ...overrides,
  };
}

describe('mapAnilistUserRow', () => {
  it('round-trips id + name with both timestamps equal to now()', () => {
    expect(mapAnilistUserRow({ id: USER_ID, name: 'someUser' }, NOW)).toEqual({
      id: USER_ID,
      name: 'someUser',
      fetched_at: NOW,
      updated_at: NOW,
    });
  });
});

describe('mapMediaRow', () => {
  it('produces a complete row when every optional field is populated', () => {
    const row = mapMediaRow(fullMedia(), NOW);
    expect(row).toEqual({
      id: 100,
      type: 'ANIME',
      title_english: 'EN',
      title_romaji: 'RO',
      title_native: 'NA',
      cover_image: 'https://example.test/cover.jpg',
      format: 'TV',
      status: 'FINISHED',
      episodes: 12,
      chapters: null,
      start_year: 2020,
      start_month: 1,
      start_day: 5,
      end_year: 2020,
      end_month: 3,
      end_day: 28,
      season: 'WINTER',
      season_year: 2020,
      mean_score: 78,
      favourites: 1234,
      country_of_origin: 'JP',
      genres_json: JSON.stringify(['Romance', 'Slice of Life']),
      synonyms_json: JSON.stringify(['Test Alt Title']),
      fetched_at: NOW,
      updated_at: NOW,
    });
  });

  it('collapses nullable scalars and missing nested objects to safe defaults', () => {
    const sparse: AnilistMediaGql = {
      id: 200,
      type: 'MANGA',
      title: { english: null, romaji: null, native: null },
      coverImage: null,
      format: null,
      status: null,
      episodes: null,
      chapters: null,
      startDate: null,
      endDate: null,
      season: null,
      seasonYear: null,
      meanScore: null,
      favourites: null,
      countryOfOrigin: null,
      genres: null,
      synonyms: null,
      studios: null,
      tags: null,
    };
    const row = mapMediaRow(sparse, NOW);
    expect(row.title_english).toBeNull();
    expect(row.cover_image).toBeNull();
    expect(row.start_year).toBeNull();
    expect(row.start_month).toBeNull();
    expect(row.start_day).toBeNull();
    expect(row.end_year).toBeNull();
    expect(row.end_month).toBeNull();
    expect(row.end_day).toBeNull();
    expect(row.country_of_origin).toBeNull();
    // genres_json coerces null → '[]' so JSON queries are uniform.
    expect(row.genres_json).toBe('[]');
    // synonyms_json keeps null as null — no synonym is a real signal vs empty array.
    expect(row.synonyms_json).toBeNull();
    expect(row.fetched_at).toBe(NOW);
    expect(row.updated_at).toBe(NOW);
  });

  it('handles a FuzzyDate where only some parts are populated', () => {
    const media = fullMedia({
      startDate: fuzzy(2022, null, null),
      endDate: fuzzy(null, 12, 25),
    });
    const row = mapMediaRow(media, NOW);
    expect(row.start_year).toBe(2022);
    expect(row.start_month).toBeNull();
    expect(row.start_day).toBeNull();
    expect(row.end_year).toBeNull();
    expect(row.end_month).toBe(12);
    expect(row.end_day).toBe(25);
  });

  it('empty synonyms array maps to NULL (no-aliases is a meaningful signal)', () => {
    const row = mapMediaRow(fullMedia({ synonyms: [] }), NOW);
    expect(row.synonyms_json).toBeNull();
  });
});

describe('studio/tag mappers', () => {
  it('mapStudioRows returns one row per unique studio node', () => {
    const rows = mapStudioRows(fullMedia(), NOW);
    expect(rows).toEqual([
      { id: 10, name: 'A-1 Pictures', fetched_at: NOW },
      { id: 11, name: 'CloverWorks', fetched_at: NOW },
    ]);
  });

  it('mapMediaStudioRows preserves AniList ordering as 0-based sort_order', () => {
    const rows = mapMediaStudioRows(fullMedia());
    expect(rows).toEqual([
      { media_id: 100, studio_id: 10, sort_order: 0 },
      { media_id: 100, studio_id: 11, sort_order: 1 },
    ]);
  });

  it('mapTagRows + mapMediaTagRows preserve per-media rank', () => {
    const tagRows = mapTagRows(fullMedia(), NOW);
    expect(tagRows).toEqual([
      { name: 'Romance', fetched_at: NOW },
      { name: 'School', fetched_at: NOW },
    ]);
    const junction = mapMediaTagRows(fullMedia());
    expect(junction).toEqual([
      { media_id: 100, tag_name: 'Romance', rank: 90 },
      { media_id: 100, tag_name: 'School', rank: 70 },
    ]);
  });

  it('empty studio/tag arrays yield empty row arrays (no orphan junctions)', () => {
    const media = fullMedia({ studios: { nodes: [] }, tags: [] });
    expect(mapStudioRows(media, NOW)).toEqual([]);
    expect(mapMediaStudioRows(media)).toEqual([]);
    expect(mapTagRows(media, NOW)).toEqual([]);
    expect(mapMediaTagRows(media)).toEqual([]);
  });

  // Regression: AniList's `studios.nodes` is a one-per-edge view, so a
  // studio that appears in two StudioEdge entries for the same media
  // (e.g. once as main and once as a secondary producer credit) leaks
  // through as duplicate nodes. Inserting both into media_studio would
  // blow the (media_id, studio_id) PK and abort the whole import.
  it('mapMediaStudioRows dedups duplicate studio ids within one media', () => {
    const media = fullMedia({
      studios: {
        nodes: [
          { id: 10, name: 'A-1 Pictures' },
          { id: 11, name: 'CloverWorks' },
          { id: 10, name: 'A-1 Pictures' }, // duplicate
        ],
      },
    });
    expect(mapMediaStudioRows(media)).toEqual([
      { media_id: 100, studio_id: 10, sort_order: 0 },
      { media_id: 100, studio_id: 11, sort_order: 1 },
    ]);
    // The parent metadata mapper applies the same dedup — keeps a
    // consistent count and avoids redundant UPSERTs in the batch.
    expect(mapStudioRows(media, NOW)).toEqual([
      { id: 10, name: 'A-1 Pictures', fetched_at: NOW },
      { id: 11, name: 'CloverWorks', fetched_at: NOW },
    ]);
  });

  it('mapMediaTagRows dedups duplicate tag names within one media', () => {
    const media = fullMedia({
      tags: [
        { name: 'Romance', rank: 90 },
        { name: 'School', rank: 70 },
        { name: 'Romance', rank: 50 }, // duplicate (lower rank ignored, first wins)
      ],
    });
    expect(mapMediaTagRows(media)).toEqual([
      { media_id: 100, tag_name: 'Romance', rank: 90 },
      { media_id: 100, tag_name: 'School', rank: 70 },
    ]);
    expect(mapTagRows(media, NOW)).toEqual([
      { name: 'Romance', fetched_at: NOW },
      { name: 'School', fetched_at: NOW },
    ]);
  });
});

describe('mapMediaListEntryRow', () => {
  it('preserves score=0 as the "not rated" sentinel (not null)', () => {
    const row = mapMediaListEntryRow(
      fullEntry({ score: 0, status: 'PLANNING' }),
      USER_ID,
      NOW,
    );
    expect(row.score).toBe(0);
    expect(row.status).toBe('PLANNING');
    expect(row.media_id).toBe(100);
    expect(row.anilist_user_id).toBe(USER_ID);
    expect(row.repeat).toBeNull();
  });

  it('destructures startedAt / completedAt FuzzyDates independently', () => {
    const row = mapMediaListEntryRow(
      fullEntry({
        startedAt: fuzzy(2023, 4, 1),
        completedAt: fuzzy(2023, 6, 15),
      }),
      USER_ID,
      NOW,
    );
    expect(row.started_year).toBe(2023);
    expect(row.completed_month).toBe(6);
    expect(row.completed_day).toBe(15);
  });

  it('converts AniList createdAt/updatedAt (seconds) to MS', () => {
    // AniList returns these as seconds-since-epoch; the mapper × 1000s.
    const row = mapMediaListEntryRow(
      fullEntry({ createdAt: 1_700_000_000, updatedAt: 1_700_000_500 }),
      USER_ID,
      NOW,
    );
    expect(row.anilist_created_at).toBe(1_700_000_000_000);
    expect(row.anilist_updated_at).toBe(1_700_000_500_000);
  });

  it('passes null createdAt/updatedAt through (pre-feature entries)', () => {
    const row = mapMediaListEntryRow(fullEntry(), USER_ID, NOW);
    expect(row.anilist_created_at).toBeNull();
    expect(row.anilist_updated_at).toBeNull();
  });

  it('carries the repeat count through when set', () => {
    const row = mapMediaListEntryRow(fullEntry({ repeat: 3 }), USER_ID, NOW);
    expect(row.repeat).toBe(3);
  });
});

describe('collectCustomListIdentities', () => {
  /**
   * Small helper to spell `Array<{name, enabled: true}>` more
   * concisely in test fixtures. The full `customLists(asArray: true)`
   * shape that AniList returns is `Array<{name, enabled}>` (one entry
   * per list the user has DEFINED), but most tests only care about the
   * enabled-true case. Tests that exercise the disabled-flag handling
   * build the array literally below.
   */
  const enabled = (...names: string[]) =>
    names.map((name) => ({ name, enabled: true }));

  it('returns one identity per unique (name, type) across the page', () => {
    const entries = [
      fullEntry({ customLists: enabled('Top 2023', 'Currently Watching') }),
      fullEntry({ customLists: enabled('Top 2023'), media: fullMedia({ id: 101 }) }),
      // Same name, different type — distinct identity per AniList's model.
      fullEntry({
        customLists: enabled('Top 2023'),
        media: fullMedia({ id: 200, type: 'MANGA' }),
      }),
    ];
    const ids = collectCustomListIdentities(entries, USER_ID);
    expect(ids).toEqual([
      { anilist_user_id: USER_ID, name: 'Top 2023', media_type: 'ANIME' },
      { anilist_user_id: USER_ID, name: 'Currently Watching', media_type: 'ANIME' },
      { anilist_user_id: USER_ID, name: 'Top 2023', media_type: 'MANGA' },
    ]);
  });

  it('returns [] when no entry references any custom list', () => {
    expect(collectCustomListIdentities([fullEntry()], USER_ID)).toEqual([]);
  });

  it('skips {enabled: false} elements — the list exists for the user but this entry is not in it', () => {
    // Regression for the SQLite bind failure caused by the wrong
    // assumption that `customLists(asArray: true)` returned a bare
    // `string[]`. The real shape is `Array<{name, enabled}>` where
    // AniList includes one element per user-defined list with
    // `enabled` indicating membership. A user reported the bug after
    // creating a list named "★" — every entry not in the ★ list
    // surfaced as `{name: "★", enabled: false}`, which the importer
    // had been blindly serialising into the `name` column.
    const entries = [
      fullEntry({
        customLists: [
          { name: 'Top 2023', enabled: true },
          { name: '★', enabled: false },
        ],
      }),
      fullEntry({
        customLists: [
          { name: 'Top 2023', enabled: false },
          { name: '★', enabled: false },
        ],
        media: fullMedia({ id: 101 }),
      }),
    ];
    const ids = collectCustomListIdentities(entries, USER_ID);
    expect(ids).toEqual([
      { anilist_user_id: USER_ID, name: 'Top 2023', media_type: 'ANIME' },
    ]);
  });

  it('returns [] when every element is enabled: false (disabled-only user)', () => {
    const entries = [
      fullEntry({
        customLists: [
          { name: 'Top 2023', enabled: false },
          { name: '★', enabled: false },
        ],
      }),
    ];
    expect(collectCustomListIdentities(entries, USER_ID)).toEqual([]);
  });
});

describe('character / staff mappers', () => {
  const character: AnilistCharacterGql = {
    id: 5000,
    name: {
      full: 'Char Name',
      native: 'キャラ',
      alternative: ['Alt Name', 'Nickname'],
      alternativeSpoiler: ['True Identity'],
    },
    image: { large: 'https://example.test/c.jpg' },
    age: '17',
    gender: 'Female',
    favourites: 999,
  };

  const staff: AnilistStaffGql = {
    id: 9000,
    name: { full: 'Staff Name', native: 'スタッフ' },
    languageV2: 'Japanese',
    image: { large: 'https://example.test/s.jpg' },
    age: null,
    gender: null,
    favourites: 12,
  };

  it('mapCharacterRow stores alternatives as JSON and gracefully handles nulls', () => {
    const row = mapCharacterRow(character, NOW);
    expect(row.name_alternatives_json).toBe(JSON.stringify(['Alt Name', 'Nickname']));
    expect(row.name_alternatives_spoiler_json).toBe(JSON.stringify(['True Identity']));
  });

  it('mapCharacterRow returns NULL for empty alternative arrays', () => {
    const row = mapCharacterRow(
      {
        ...character,
        name: { full: null, native: null, alternative: [], alternativeSpoiler: null },
        image: null,
      },
      NOW,
    );
    expect(row.name_full).toBeNull();
    expect(row.name_native).toBeNull();
    expect(row.image).toBeNull();
    expect(row.name_alternatives_json).toBeNull();
    expect(row.name_alternatives_spoiler_json).toBeNull();
  });

  it('mapStaffRow round-trips populated fields including languageV2', () => {
    const row = mapStaffRow(staff, NOW);
    expect(row).toEqual({
      id: 9000,
      name_full: 'Staff Name',
      name_native: 'スタッフ',
      image: 'https://example.test/s.jpg',
      age: null,
      gender: null,
      language_v2: 'Japanese',
      favourites: 12,
      fetched_at: NOW,
      updated_at: NOW,
    });
  });

  it('mapStaffRow tolerates a missing languageV2', () => {
    const row = mapStaffRow({ ...staff, languageV2: null }, NOW);
    expect(row.language_v2).toBeNull();
  });

  it('mapMediaCharacterRows preserves edge ordering as sort_order', () => {
    const edges: AnilistMediaCharacterEdgeGql[] = [
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [] },
      { role: 'SUPPORTING', node: { ...character, id: 2 }, voiceActors: [] },
      { role: 'BACKGROUND', node: { ...character, id: 3 }, voiceActors: [] },
    ];
    expect(mapMediaCharacterRows(100, edges)).toEqual([
      { media_id: 100, character_id: 1, role: 'MAIN', sort_order: 0 },
      { media_id: 100, character_id: 2, role: 'SUPPORTING', sort_order: 1 },
      { media_id: 100, character_id: 3, role: 'BACKGROUND', sort_order: 2 },
    ]);
  });

  it('mapCharacterVoiceActorRows hardcodes the supplied language and skips empty VA edges', () => {
    const edges: AnilistMediaCharacterEdgeGql[] = [
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [staff] },
      { role: 'SUPPORTING', node: { ...character, id: 2 }, voiceActors: [] },
      {
        role: 'SUPPORTING',
        node: { ...character, id: 3 },
        voiceActors: [staff, { ...staff, id: 9001 }],
      },
    ];
    const rows = mapCharacterVoiceActorRows(100, edges, 'JAPANESE');
    expect(rows).toEqual([
      { media_id: 100, character_id: 1, staff_id: 9000, language: 'JAPANESE' },
      { media_id: 100, character_id: 3, staff_id: 9000, language: 'JAPANESE' },
      { media_id: 100, character_id: 3, staff_id: 9001, language: 'JAPANESE' },
    ]);
  });

  // Regression: AniList sometimes returns the same VA twice inside one
  // character's `voiceActors` (e.g. a VA credited under multiple staff
  // aliases that resolve to the same id). Without dedup the rebuild
  // transaction crashes with SQLITE_CONSTRAINT_PRIMARYKEY on
  // (media_id, character_id, staff_id, language) and rolls back the
  // whole lazy expansion.
  it('mapCharacterVoiceActorRows dedups repeated VAs within one character edge', () => {
    const edges: AnilistMediaCharacterEdgeGql[] = [
      {
        role: 'MAIN',
        node: { ...character, id: 1 },
        voiceActors: [staff, staff, { ...staff, id: 9001 }],
      },
    ];
    const rows = mapCharacterVoiceActorRows(100, edges, 'JAPANESE');
    expect(rows).toEqual([
      { media_id: 100, character_id: 1, staff_id: 9000, language: 'JAPANESE' },
      { media_id: 100, character_id: 1, staff_id: 9001, language: 'JAPANESE' },
    ]);
  });

  // Regression: AniList's `Media.characters` connection paginates with
  // a non-stable sort under ties, so the same character edge can show
  // up on two pages. After the lazy expander concatenates pages and
  // passes the merged array here, both (character_id) and
  // (character_id, staff_id) repeat — the mapper must squash both.
  it('mapCharacterVoiceActorRows dedups VAs across repeated character edges (paginated dup)', () => {
    const edges: AnilistMediaCharacterEdgeGql[] = [
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [staff] },
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [staff] },
    ];
    const rows = mapCharacterVoiceActorRows(100, edges, 'JAPANESE');
    expect(rows).toEqual([
      { media_id: 100, character_id: 1, staff_id: 9000, language: 'JAPANESE' },
    ]);
  });

  // Same paginated-dup quirk hits media_character first (PK =
  // media_id, character_id). Keep the FIRST occurrence's sort_order so
  // characters that AniList ranked highly on page 1 don't get pushed
  // to the bottom when they repeat on a later page.
  it('mapMediaCharacterRows dedups repeated character edges and keeps the first sort_order', () => {
    const edges: AnilistMediaCharacterEdgeGql[] = [
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [] },
      { role: 'SUPPORTING', node: { ...character, id: 2 }, voiceActors: [] },
      // Repeat of id=1 from a later page — must be dropped.
      { role: 'MAIN', node: { ...character, id: 1 }, voiceActors: [] },
      { role: 'BACKGROUND', node: { ...character, id: 3 }, voiceActors: [] },
    ];
    expect(mapMediaCharacterRows(100, edges)).toEqual([
      { media_id: 100, character_id: 1, role: 'MAIN', sort_order: 0 },
      { media_id: 100, character_id: 2, role: 'SUPPORTING', sort_order: 1 },
      { media_id: 100, character_id: 3, role: 'BACKGROUND', sort_order: 3 },
    ]);
  });
});

describe('favourite-edge mappers', () => {
  it('mapMediaFavouriteRow uses favouriteOrder as sort_order and threads anilist_user_id', () => {
    const edge: AnilistFavouriteEdge<AnilistMediaGql> = {
      favouriteOrder: 7,
      node: fullMedia({ id: 500 }),
    };
    expect(mapMediaFavouriteRow(edge, USER_ID, NOW)).toEqual({
      anilist_user_id: USER_ID,
      media_id: 500,
      sort_order: 7,
      fetched_at: NOW,
    });
  });

  it('mapCharacterFavouriteRow / mapStaffFavouriteRow / mapStudioFavouriteRow are symmetrical and user-scoped', () => {
    expect(
      mapCharacterFavouriteRow(
        {
          favouriteOrder: 0,
          node: {
            id: 1,
            name: { full: 'X', native: null, alternative: null, alternativeSpoiler: null },
            image: null,
            age: null,
            gender: null,
            favourites: null,
          },
        },
        USER_ID,
        NOW,
      ),
    ).toEqual({ anilist_user_id: USER_ID, character_id: 1, sort_order: 0, fetched_at: NOW });

    expect(
      mapStaffFavouriteRow(
        {
          favouriteOrder: 3,
          node: {
            id: 2,
            name: { full: 'Y', native: null },
            languageV2: null,
            image: null,
            age: null,
            gender: null,
            favourites: null,
          },
        },
        USER_ID,
        NOW,
      ),
    ).toEqual({ anilist_user_id: USER_ID, staff_id: 2, sort_order: 3, fetched_at: NOW });

    expect(
      mapStudioFavouriteRow({ favouriteOrder: 9, node: { id: 99, name: 'S' } }, USER_ID, NOW),
    ).toEqual({ anilist_user_id: USER_ID, studio_id: 99, sort_order: 9, fetched_at: NOW });
  });
});

describe('mapStaffCharacterAppearanceData', () => {
  it('maps Staff.characterMedia edges with characterRole and nested characters', () => {
    const media = fullMedia({ id: 300 });
    const charA = {
      id: 10,
      name: { full: 'Hero', native: null, alternative: null, alternativeSpoiler: null },
      image: { large: null },
      age: null,
      gender: null,
      favourites: null,
    };
    const charB = {
      id: 11,
      name: { full: 'Sidekick', native: null, alternative: null, alternativeSpoiler: null },
      image: { large: null },
      age: null,
      gender: null,
      favourites: null,
    };
    const result = mapStaffCharacterAppearanceData(
      99,
      [
        {
          characterRole: 'MAIN',
          characters: [charA, charB],
          node: media,
        },
      ],
      'JAPANESE',
      NOW,
    );
    expect(result.mediaRows).toHaveLength(1);
    expect(result.mediaRows[0]!.id).toBe(300);
    expect(result.characterRows.map((c) => c.id).sort()).toEqual([10, 11]);
    expect(result.mediaCharacterRows).toHaveLength(2);
    expect(result.mediaCharacterRows[0]).toMatchObject({
      media_id: 300,
      character_id: 10,
      role: 'MAIN',
    });
    expect(result.cvaRows).toHaveLength(2);
    expect(result.cvaRows[0]).toMatchObject({
      media_id: 300,
      character_id: 10,
      staff_id: 99,
      language: 'JAPANESE',
    });
  });

  it('skips null media nodes and null character slots in characterMedia edges', () => {
    const media = fullMedia({ id: 300 });
    const charA = {
      id: 10,
      name: { full: 'Hero', native: null, alternative: null, alternativeSpoiler: null },
      image: { large: null },
      age: null,
      gender: null,
      favourites: null,
    };
    const result = mapStaffCharacterAppearanceData(
      99,
      [
        {
          characterRole: 'MAIN',
          characters: [charA, null],
          node: media,
        },
        {
          characterRole: 'SUPPORTING',
          characters: [charA],
          node: null,
        },
      ],
      'JAPANESE',
      NOW,
    );
    expect(result.mediaRows).toHaveLength(1);
    expect(result.characterRows).toHaveLength(1);
    expect(result.cvaRows).toHaveLength(1);
  });
});

describe('mapStaffFilmographyMediaStaffRows', () => {
  it('maps MediaEdge.staffRole from Staff.staffMedia', () => {
    const rows = mapStaffFilmographyMediaStaffRows(42, [
      { staffRole: 'Director', node: fullMedia({ id: 200 }) },
      { staffRole: null, node: fullMedia({ id: 201 }) },
    ]);
    expect(rows).toEqual([
      { media_id: 200, staff_id: 42, role: 'Director', sort_order: 0 },
      { media_id: 201, staff_id: 42, role: 'Unknown', sort_order: 1 },
    ]);
  });

  it('skips Staff.staffMedia edges with null media nodes', () => {
    const rows = mapStaffFilmographyMediaStaffRows(42, [
      { staffRole: 'Director', node: fullMedia({ id: 200 }) },
      { staffRole: 'Theme Song Performance', node: null },
    ]);
    expect(rows).toEqual([{ media_id: 200, staff_id: 42, role: 'Director', sort_order: 0 }]);
  });
});
