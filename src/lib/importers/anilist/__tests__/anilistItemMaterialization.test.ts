import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../../types';
import {
  applyCachedAnilistItemEdit,
  cachedAnilistSourcesForUsername,
  listCachedAnilistSources,
  parseCanonicalAnilistItemId,
  resolveCachedAnilistItemId,
} from '../anilistItemMaterialization';
import { productionReads } from '../readQueries';
import type { CharacterRow, MediaRow, StaffRow } from '../types';

afterEach(() => {
  vi.restoreAllMocks();
});

function mediaRow(): MediaRow {
  return {
    id: 123,
    type: 'ANIME',
    title_english: 'English title',
    title_romaji: 'Romaji title',
    title_native: '日本語',
    cover_image: 'cover.jpg',
    format: 'TV',
    source: null,
    source_fetched_at: null,
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    start_year: 2020,
    start_month: 1,
    start_day: 1,
    end_year: 2020,
    end_month: 3,
    end_day: 1,
    season: 'WINTER',
    season_year: 2020,
    mean_score: 80,
    favourites: 10,
    country_of_origin: 'JP',
    genres_json: '[]',
    synonyms_json: '["Alias"]',
    fetched_at: 1,
    updated_at: 1,
  };
}

describe('AniList item materialization', () => {
  it('lists all seven refreshed source categories even when they are empty', async () => {
    vi.spyOn(productionReads, 'getCachedAnilistUsers').mockResolvedValue([
      { id: 1, name: 'CachedUser', fetched_at: 1 },
    ]);
    vi.spyOn(productionReads, 'getListedMediaCount').mockResolvedValue(0);
    vi.spyOn(productionReads, 'getLastFullRefresh').mockResolvedValue(100);
    vi.spyOn(productionReads, 'getFavouritesAsItems').mockResolvedValue([]);
    vi.spyOn(productionReads, 'getLastFavouritesRefresh').mockResolvedValue(200);

    const sources = await listCachedAnilistSources();

    expect(sources).toHaveLength(7);
    expect(sources.map(({ source }) => `${source.kind}:${source.type}`)).toEqual([
      'list:ANIME',
      'list:MANGA',
      'favourites:ANIME',
      'favourites:MANGA',
      'favourites:CHARACTERS',
      'favourites:STAFF',
      'favourites:STUDIOS',
    ]);
    expect(sources.map(({ refreshedAt }) => refreshedAt)).toEqual([
      100, 100, 200, 200, 200, 200, 200,
    ]);
  });

  it('filters cached sources by a trimmed case-insensitive username', () => {
    const sources = [
      {
        source: {
          kind: 'list' as const,
          userId: 1,
          userName: 'CachedUser',
          type: 'ANIME' as const,
        },
        count: 2,
        refreshedAt: null,
      },
      {
        source: {
          kind: 'list' as const,
          userId: 2,
          userName: 'OtherUser',
          type: 'MANGA' as const,
        },
        count: 3,
        refreshedAt: null,
      },
    ];

    expect(cachedAnilistSourcesForUsername(sources, ' cacheduser ')).toEqual([
      sources[0],
    ]);
    expect(cachedAnilistSourcesForUsername(sources, '')).toEqual([]);
  });

  it('strictly parses supported positive canonical ids', () => {
    expect(parseCanonicalAnilistItemId('anilist:123')).toEqual({
      kind: 'media',
      externalId: 123,
    });
    expect(parseCanonicalAnilistItemId('anilist-character:7')).toEqual({
      kind: 'character',
      externalId: 7,
    });
    expect(parseCanonicalAnilistItemId('anilist-staff:9')).toEqual({
      kind: 'staff',
      externalId: 9,
    });
    expect(parseCanonicalAnilistItemId('anilist:0')).toBeNull();
    expect(parseCanonicalAnilistItemId('anilist:12x')).toBeNull();
    expect(parseCanonicalAnilistItemId('manual:123')).toBeNull();
  });

  it('resolves a cached media id into complete canonical metadata', async () => {
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([mediaRow()]);
    const item = await resolveCachedAnilistItemId('anilist:123', false);
    expect(item).toMatchObject({
      id: 'anilist:123',
      url: 'https://anilist.co/anime/123',
      imageUrl: 'cover.jpg',
      source: { kind: 'anilist', externalId: 123 },
    });
    expect(item?.searchTokens).toContain('Alias');
    expect(item?.anilistLabelSource?.kind).toBe('media');
  });

  it('returns null for a valid-looking id that is absent from cache', async () => {
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([]);
    await expect(resolveCachedAnilistItemId('anilist:999')).resolves.toBeNull();
  });

  it('resolves cached character and staff ids with canonical metadata', async () => {
    const character: CharacterRow = {
      id: 7,
      name_full: 'Character Name',
      name_native: 'キャラクター',
      name_alternatives_json: '["Character Alias"]',
      name_alternatives_spoiler_json: '[]',
      image: 'character.jpg',
      age: null,
      gender: null,
      favourites: 1,
      birth_year: null,
      birth_month: null,
      birth_day: null,
      fetched_at: 1,
      updated_at: 1,
    };
    const staff: StaffRow = {
      id: 9,
      name_full: 'Staff Name',
      name_native: 'スタッフ',
      image: 'staff.jpg',
      age: null,
      gender: null,
      language_v2: null,
      favourites: 1,
      fetched_at: 1,
      updated_at: 1,
    };
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      character,
    ]);
    vi.spyOn(productionReads, 'getStaffByIds').mockResolvedValue([staff]);

    await expect(
      resolveCachedAnilistItemId('anilist-character:7', false),
    ).resolves.toMatchObject({
      id: 'anilist-character:7',
      label: 'Character Name',
      url: 'https://anilist.co/character/7',
      imageUrl: 'character.jpg',
      source: { kind: 'anilist-character', externalId: 7 },
      searchTokens: expect.arrayContaining([
        'Character Name',
        'キャラクター',
        'Character Alias',
      ]),
      anilistLabelSource: { kind: 'character' },
    });
    await expect(
      resolveCachedAnilistItemId('anilist-staff:9', false),
    ).resolves.toMatchObject({
      id: 'anilist-staff:9',
      label: 'Staff Name',
      url: 'https://anilist.co/staff/9',
      imageUrl: 'staff.jpg',
      source: { kind: 'anilist-staff', externalId: 9 },
      searchTokens: expect.arrayContaining(['Staff Name', 'スタッフ']),
      anilistLabelSource: { kind: 'person' },
    });
  });

  it('uses hydrated metadata as the base while explicit edits win', () => {
    const original: Item = { id: 'manual', label: 'Manual' };
    const hydrated: Item = {
      id: 'anilist:123',
      label: 'Cached',
      url: 'cached-url',
      imageUrl: 'cached-image',
      source: { kind: 'anilist', externalId: 123 },
      searchTokens: ['Cached', 'Alias'],
    };
    const updated = applyCachedAnilistItemEdit(original, {
      id: hydrated.id,
      hydratedItem: hydrated,
      label: 'My label',
    });
    expect(updated).toMatchObject({
      id: 'anilist:123',
      label: 'My label',
      url: 'cached-url',
      imageUrl: 'cached-image',
      source: { kind: 'anilist', externalId: 123 },
    });
  });
});
