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
  it('mapStudioRows returns one row per studio node, deduplicated by the importer not here', () => {
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
  it('returns one identity per unique (name, type) across the page', () => {
    const entries = [
      fullEntry({ customLists: ['Top 2023', 'Currently Watching'] }),
      fullEntry({ customLists: ['Top 2023'], media: fullMedia({ id: 101 }) }),
      // Same name, different type — distinct identity per AniList's model.
      fullEntry({
        customLists: ['Top 2023'],
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
