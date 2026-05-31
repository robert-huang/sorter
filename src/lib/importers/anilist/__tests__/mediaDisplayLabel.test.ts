import { describe, expect, it } from 'vitest';
import { formatMediaDisplayLabel, pickMediaTitle } from '../mediaDisplayLabel';

describe('pickMediaTitle', () => {
  it('prefers romaji over english and native', () => {
    expect(
      pickMediaTitle({
        id: 1,
        title_romaji: 'Shinryaku! Ika Musume',
        title_english: 'Squid Girl',
        title_native: '侵略!',
      }),
    ).toBe('Shinryaku! Ika Musume');
  });
});

describe('formatMediaDisplayLabel', () => {
  it('appends AniList format when requested', () => {
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
