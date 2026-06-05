import { describe, expect, it } from 'vitest';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../displayPreferences';
import {
  formatMediaDisplayLabel,
  mediaTitleSearchParts,
  pickMediaTitle,
} from '../mediaDisplayLabel';

const FIELDS = {
  id: 1,
  title_romaji: 'Shinryaku! Ika Musume',
  title_english: 'Squid Girl',
  title_native: '侵略!',
};

describe('pickMediaTitle', () => {
  it('defaults to romaji-first when no preference is stored', () => {
    _clearAnilistDisplayPreferencesForTesting();
    expect(pickMediaTitle(FIELDS)).toBe('Shinryaku! Ika Musume');
  });

  it('prefers english when display mode is english', () => {
    _clearAnilistDisplayPreferencesForTesting();
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    expect(pickMediaTitle(FIELDS)).toBe('Squid Girl');
  });

  it('prefers native when display mode is native', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    expect(pickMediaTitle(FIELDS)).toBe('侵略!');
  });

  it('prefers romaji when display mode is romaji', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'romaji' });
    expect(pickMediaTitle(FIELDS)).toBe('Shinryaku! Ika Musume');
  });

  it('falls back native → english → romaji in native mode', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    expect(
      pickMediaTitle({
        id: 5,
        title_romaji: 'Romaji Only',
        title_english: 'English Only',
        title_native: null,
      }),
    ).toBe('English Only');
    expect(
      pickMediaTitle({
        id: 6,
        title_romaji: 'Romaji Only',
        title_english: null,
        title_native: null,
      }),
    ).toBe('Romaji Only');
  });

  it('falls back through romaji when the preferred title is missing', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    expect(
      pickMediaTitle({
        id: 2,
        title_romaji: 'Romaji Only',
        title_english: null,
        title_native: null,
      }),
    ).toBe('Romaji Only');
  });

  it('uses the caller-supplied fallback over the Untitled placeholder', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    expect(
      pickMediaTitle(
        { id: 7, title_romaji: null, title_english: null, title_native: null },
        undefined,
        'Clicked Label',
      ),
    ).toBe('Clicked Label');
  });
});

describe('mediaTitleSearchParts', () => {
  it('includes every stored title variant and synonyms', () => {
    const parts = mediaTitleSearchParts({
      ...FIELDS,
      synonyms_json: '["Ikamusume"]',
    });
    expect(parts).toEqual(
      expect.arrayContaining(['Shinryaku! Ika Musume', 'Squid Girl', '侵略!', 'Ikamusume']),
    );
  });
});

describe('formatMediaDisplayLabel', () => {
  it('appends AniList format when requested', () => {
    _clearAnilistDisplayPreferencesForTesting();
    expect(
      formatMediaDisplayLabel(
        {
          id: 1,
          title_romaji: 'Shinryaku! Ika Musume',
          title_english: null,
          title_native: null,
        },
        'TV',
        true,
      ),
    ).toBe('Shinryaku! Ika Musume (TV)');
  });

  it('supports TV_SHORT and NOVEL formats', () => {
    expect(
      formatMediaDisplayLabel(
        {
          id: 2,
          title_romaji: 'Tsurezure Children',
          title_english: null,
          title_native: null,
        },
        'TV_SHORT',
        true,
      ),
    ).toBe('Tsurezure Children (TV_SHORT)');

    expect(
      formatMediaDisplayLabel(
        {
          id: 3,
          title_romaji: 'Sakurada Reset',
          title_english: null,
          title_native: null,
        },
        'NOVEL',
        true,
      ),
    ).toBe('Sakurada Reset (NOVEL)');
  });

  it('omits format suffix when toggle is off or format is missing', () => {
    const fields = {
      id: 4,
      title_romaji: 'Example',
      title_english: null,
      title_native: null,
    };
    expect(formatMediaDisplayLabel(fields, 'TV', false)).toBe('Example');
    expect(formatMediaDisplayLabel(fields, null, true)).toBe('Example');
  });
});
