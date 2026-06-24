import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../displayPreferences';
import {
  itemMatchesSearch,
  mediaLabelSourceFromRow,
  relabelAnilistItem,
  relabelAnilistItemPreservingFormat,
  resolveAnilistItemLabel,
} from '../anilistItemLabel';
import type { Item } from '../../../types';

const MEDIA_FIELDS = {
  id: 1,
  title_romaji: 'Shinryaku! Ika Musume',
  title_english: 'Squid Girl',
  title_native: '侵略!',
};

beforeEach(() => {
  _clearAnilistDisplayPreferencesForTesting();
});

describe('resolveAnilistItemLabel', () => {
  it('formats a media label with the format suffix when requested', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    expect(
      resolveAnilistItemLabel(
        { kind: 'media', titleFields: MEDIA_FIELDS, format: 'TV' },
        true,
      ),
    ).toBe('Squid Girl (TV)');
  });

  it('resolves a staff label honouring the staff display mode', () => {
    saveAnilistDisplayPreferences({ personNameMode: 'native' });
    expect(
      resolveAnilistItemLabel(
        {
          kind: 'person',
          nameFields: { id: 9, name_full: 'Yui Horie', name_native: '堀江由衣' },
          fallbackLabel: 'Staff',
        },
        false,
      ),
    ).toBe('堀江由衣');
  });

  it('resolves a character label honouring the character display mode', () => {
    saveAnilistDisplayPreferences({ characterNameMode: 'native' });
    expect(
      resolveAnilistItemLabel(
        {
          kind: 'character',
          nameFields: { id: 12, name_full: 'Romaji', name_native: 'ネイティブ' },
          fallbackLabel: 'Character',
        },
        false,
      ),
    ).toBe('ネイティブ');
  });
});

describe('itemMatchesSearch', () => {
  const item: Item = {
    id: 'a',
    label: 'Squid Girl',
    searchTokens: ['Shinryaku! Ika Musume', 'Squid Girl', '侵略!'],
  };

  it('matches any stored search token, not just the label', () => {
    expect(itemMatchesSearch(item, 'ika')).toBe(true);
    expect(itemMatchesSearch(item, '侵略')).toBe(true);
  });

  it('falls back to the label when there are no tokens', () => {
    expect(
      itemMatchesSearch({ id: 'b', label: 'Cowboy Bebop' }, 'bebop'),
    ).toBe(true);
  });

  it('returns true for an empty needle and false for a miss', () => {
    expect(itemMatchesSearch(item, '')).toBe(true);
    expect(itemMatchesSearch(item, 'naruto')).toBe(false);
  });
});

describe('relabelAnilistItem', () => {
  it('returns the same reference for non-AniList items', () => {
    const item: Item = { id: 'c', label: 'Plain' };
    expect(relabelAnilistItem(item, false)).toBe(item);
  });

  it('re-resolves the label from the stored source', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    const item: Item = {
      id: 'd',
      label: 'Squid Girl',
      anilistLabelSource: { kind: 'media', titleFields: MEDIA_FIELDS, format: 'TV' },
    };
    expect(relabelAnilistItem(item, false).label).toBe('侵略!');
  });

  it('returns the same reference when the label is unchanged', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    const item: Item = {
      id: 'e',
      label: 'Squid Girl',
      anilistLabelSource: { kind: 'media', titleFields: MEDIA_FIELDS, format: 'TV' },
    };
    expect(relabelAnilistItem(item, false)).toBe(item);
  });
});

describe('relabelAnilistItemPreservingFormat', () => {
  it('keeps the (FORMAT) suffix when the previous label carried it', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    const item: Item = {
      id: 'f',
      label: 'Squid Girl (TV)',
      anilistLabelSource: { kind: 'media', titleFields: MEDIA_FIELDS, format: 'TV' },
    };
    expect(relabelAnilistItemPreservingFormat(item).label).toBe('侵略! (TV)');
  });

  it('omits the suffix when the previous label had none', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'native' });
    const item: Item = {
      id: 'g',
      label: 'Squid Girl',
      anilistLabelSource: { kind: 'media', titleFields: MEDIA_FIELDS, format: 'TV' },
    };
    expect(relabelAnilistItemPreservingFormat(item).label).toBe('侵略!');
  });
});

describe('mediaLabelSourceFromRow', () => {
  it('projects only the title fields + format', () => {
    expect(mediaLabelSourceFromRow({ ...MEDIA_FIELDS, format: 'MOVIE' })).toEqual({
      kind: 'media',
      titleFields: MEDIA_FIELDS,
      format: 'MOVIE',
    });
  });
});
