import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../../types';
import {
  canRefreshAnilistItem,
  hydrateAnilistItemRecord,
  needsAnilistItemHydration,
} from '../anilistItemHydration';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../displayPreferences';
import { productionReads } from '../readQueries';
import type { MediaRow } from '../types';

function mediaRow(
  id: number,
  titleEnglish: string,
  titleRomaji: string,
  titleNative: string,
): MediaRow {
  return {
    id,
    type: 'ANIME',
    title_english: titleEnglish,
    title_romaji: titleRomaji,
    title_native: titleNative,
    cover_image: `https://example.com/${id}.jpg`,
    format: 'TV',
    status: null,
    episodes: null,
    chapters: null,
    start_year: null,
    start_month: null,
    start_day: null,
    end_year: null,
    end_month: null,
    end_day: null,
    season: null,
    season_year: null,
    mean_score: null,
    favourites: null,
    country_of_origin: null,
    genres_json: null,
    synonyms_json: null,
    fetched_at: 1,
    updated_at: 1,
  };
}

beforeEach(() => {
  _clearAnilistDisplayPreferencesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistent AniList item hydration', () => {
  it('repairs media, character, staff, and source-less studio metadata', async () => {
    saveAnilistDisplayPreferences({
      mediaTitleMode: 'english',
      characterNameMode: 'full',
      personNameMode: 'full',
    });
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([
      mediaRow(1, 'English title', 'Romaji title', '原題'),
    ]);
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      {
        id: 2,
        name_full: 'Character Name',
        name_native: '登場人物',
        name_alternatives_json: null,
        name_alternatives_spoiler_json: null,
        image: null,
        gender: null,
        favourites: null,
      },
    ]);
    vi.spyOn(productionReads, 'getStaffByIds').mockResolvedValue([
      {
        id: 3,
        name_full: 'Staff Name',
        name_native: 'スタッフ',
        image: null,
        gender: null,
        language_v2: null,
        favourites: null,
      },
    ]);
    vi.spyOn(productionReads, 'getStudiosByIds').mockResolvedValue([
      { id: 4, name: 'Studio Name' },
    ]);
    const manual: Item = { id: 'manual', label: 'Manual item' };
    const items: Record<string, Item> = {
      media: {
        id: 'anilist:1',
        label: '原題',
        source: { kind: 'anilist', externalId: 1 },
      },
      character: {
        id: 'anilist-character:2',
        label: '登場人物',
        source: { kind: 'anilist-character', externalId: 2 },
      },
      staff: {
        id: 'anilist-staff:3',
        label: 'スタッフ',
        source: { kind: 'anilist-staff', externalId: 3 },
      },
      studio: { id: 'anilist-studios:4', label: 'Studio Name' },
      manual,
    };

    const hydrated = await hydrateAnilistItemRecord(items);

    expect(hydrated).not.toBe(items);
    expect(hydrated.media).toMatchObject({
      label: 'English title',
      imageUrl: 'https://example.com/1.jpg',
      anilistLabelSource: { kind: 'media' },
    });
    expect(hydrated.character).toMatchObject({
      label: 'Character Name',
      anilistLabelSource: { kind: 'character' },
    });
    expect(hydrated.staff).toMatchObject({
      label: 'Staff Name',
      anilistLabelSource: { kind: 'person' },
    });
    expect(hydrated.studio).toMatchObject({
      label: 'Studio Name',
      anilistLabelSource: { kind: 'studio', label: 'Studio Name' },
    });
    expect(hydrated.manual).toBe(manual);
  });

  it('pins unknown legacy labels but treats every known variant as automatic', async () => {
    saveAnilistDisplayPreferences({
      mediaTitleMode: 'english',
      characterNameMode: 'full',
    });
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([
      mediaRow(1, 'English title', 'Romaji title', '原題'),
      mediaRow(2, 'Other English', 'Other Romaji', '別題'),
      mediaRow(4, 'CSV English', 'CSV Romaji', 'CSV 原題'),
    ]);
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      {
        id: 3,
        name_full: 'Character Name',
        name_native: '登場人物',
        name_alternatives_json: null,
        name_alternatives_spoiler_json: null,
        image: null,
        gender: null,
        favourites: null,
      },
    ]);
    const items: Record<string, Item> = {
      nativeMedia: {
        id: 'anilist:1',
        label: '原題 (TV)',
        source: { kind: 'anilist', externalId: 1 },
      },
      customMedia: {
        id: 'anilist:2',
        label: 'My custom title',
        source: { kind: 'anilist', externalId: 2 },
      },
      nativeCharacter: {
        id: 'anilist-character:3',
        label: '登場人物',
        source: { kind: 'anilist-character', externalId: 3 },
      },
      currentCsvMedia: {
        id: 'anilist:4',
        label: 'Title from CSV',
        source: { kind: 'anilist', externalId: 4 },
        anilistLabelMode: 'automatic',
      },
    };

    const hydrated = await hydrateAnilistItemRecord(items);

    expect(hydrated.nativeMedia).toMatchObject({
      label: 'English title (TV)',
    });
    expect(hydrated.nativeMedia!.anilistLabelMode).toBeUndefined();
    expect(hydrated.customMedia).toMatchObject({
      label: 'My custom title',
      anilistLabelMode: 'custom',
      anilistLabelIncludesFormat: false,
    });
    expect(hydrated.nativeCharacter).toMatchObject({
      label: 'Character Name',
    });
    expect(hydrated.nativeCharacter!.anilistLabelMode).toBeUndefined();
    expect(hydrated.currentCsvMedia).toMatchObject({
      label: 'CSV English',
      anilistLabelMode: 'automatic',
    });
  });

  it('retains dictionary identity when no cached row can repair it', async () => {
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([]);
    const items: Record<string, Item> = {
      missing: {
        id: 'anilist:99',
        label: 'Missing',
        source: { kind: 'anilist', externalId: 99 },
      },
    };

    expect(needsAnilistItemHydration(items.missing!)).toBe(true);
    expect(await hydrateAnilistItemRecord(items)).toBe(items);
  });

  it('refreshes embedded source metadata while preserving identity and custom labels', async () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    const refreshed = {
      ...mediaRow(1, 'Correct Spacing', 'Shōjo Updated', '更新名'),
      cover_image: 'https://s4.anilist.co/file/anilistcdn/new.jpg',
      format: 'MOVIE' as const,
      synonyms_json: JSON.stringify(['Former Primary Title']),
    };
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([
      refreshed,
      { ...refreshed, id: 2 },
    ]);
    const oldSource = {
      kind: 'media' as const,
      titleFields: {
        id: 1,
        title_english: 'Former  Primary Title',
        title_romaji: 'Shoujo Old',
        title_native: '旧名',
      },
      format: 'TV' as const,
    };
    const automatic: Item = {
      id: 'anilist:1',
      label: 'Former  Primary Title',
      source: { kind: 'anilist', externalId: 1 },
      searchTokens: ['Former Primary Title', 'Shoujo Old', '旧名'],
      anilistLabelSource: oldSource,
      imageUrl: 'https://s4.anilist.co/file/anilistcdn/old.jpg',
      anilistImageSource: 'https://s4.anilist.co/file/anilistcdn/old.jpg',
    };
    const custom: Item = {
      ...automatic,
      id: 'anilist:2',
      label: 'My permanent title',
      source: { kind: 'anilist', externalId: 2 },
      anilistLabelMode: 'custom',
      anilistLabelIncludesFormat: false,
    };
    const items = { automatic, custom };

    expect(needsAnilistItemHydration(automatic)).toBe(false);
    expect(canRefreshAnilistItem(automatic)).toBe(true);

    const hydrated = await hydrateAnilistItemRecord(items);

    expect(hydrated.automatic).toMatchObject({
      id: 'anilist:1',
      label: 'Correct Spacing',
      imageUrl: 'https://s4.anilist.co/file/anilistcdn/new.jpg',
      anilistImageSource: 'https://s4.anilist.co/file/anilistcdn/new.jpg',
      anilistLabelSource: {
        kind: 'media',
        titleFields: {
          title_english: 'Correct Spacing',
          title_romaji: 'Shōjo Updated',
          title_native: '更新名',
        },
        format: 'MOVIE',
      },
    });
    expect(hydrated.automatic!.searchTokens).toEqual([
      'Shōjo Updated',
      'Correct Spacing',
      '更新名',
      'Former Primary Title',
    ]);
    expect(hydrated.custom).toMatchObject({
      id: 'anilist:2',
      label: 'My permanent title',
      anilistLabelMode: 'custom',
      anilistLabelSource: {
        titleFields: { title_english: 'Correct Spacing' },
      },
    });

    expect(await hydrateAnilistItemRecord(hydrated)).toBe(hydrated);
  });

  it('refreshes character alternatives without replacing a custom image', async () => {
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      {
        id: 3,
        name_full: 'Updated Name',
        name_native: '更新名',
        name_alternatives_json: JSON.stringify(['Former Name']),
        name_alternatives_spoiler_json: JSON.stringify(['Hidden Alias']),
        image: 'https://s4.anilist.co/file/anilistcdn/updated-character.jpg',
        gender: null,
        favourites: null,
      },
    ]);
    const original: Item = {
      id: 'anilist-character:3',
      label: 'Old Name',
      source: { kind: 'anilist-character', externalId: 3 },
      searchTokens: ['Old Name'],
      anilistLabelSource: {
        kind: 'character',
        nameFields: { id: 3, name_full: 'Old Name', name_native: '旧名' },
      },
      imageUrl: 'https://images.example/custom.jpg',
      anilistImageSource: 'https://s4.anilist.co/file/anilistcdn/old-character.jpg',
    };

    const hydrated = await hydrateAnilistItemRecord({ character: original });

    expect(hydrated.character).toMatchObject({
      id: 'anilist-character:3',
      label: 'Updated Name',
      imageUrl: 'https://images.example/custom.jpg',
      anilistImageSource:
        'https://s4.anilist.co/file/anilistcdn/updated-character.jpg',
    });
    expect(hydrated.character!.searchTokens).toEqual([
      'Updated Name',
      '更新名',
      'Former Name',
      'Hidden Alias',
    ]);
  });
});
