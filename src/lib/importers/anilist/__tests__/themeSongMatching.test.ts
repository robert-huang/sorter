import { describe, expect, it } from 'vitest';
import {
  collectTitleMatchCandidates,
  foldJapaneseRomanization,
  malThemeMatchesAniplaylistHit,
} from '../themeSongs/themeSongMatching';

describe('foldJapaneseRomanization', () => {
  it('folds long vowel romanizations', () => {
    expect(foldJapaneseRomanization('Oohara')).toBe('ohara');
    expect(foldJapaneseRomanization('Toukyo')).toBe('tokyo');
    expect(foldJapaneseRomanization('Yuuko')).toBe('yuko');
  });
});

describe('collectTitleMatchCandidates', () => {
  it('extracts parenthetical alternate titles from MAL strings', () => {
    expect(collectTitleMatchCandidates('Kanade (奏（かなで）)')).toEqual(
      expect.arrayContaining(['Kanade (奏（かなで）)', '奏（かなで）', 'かなで', 'Kanade']),
    );
  });
});

describe('malThemeMatchesAniplaylistHit', () => {
  it('matches when any AniPlaylist title variant matches any MAL title variant', () => {
    expect(
      malThemeMatchesAniplaylistHit(
        {
          type: 'Ending',
          title: 'Kanade (奏（かなで）)',
          artist: 'Takagi-san (Rie Takahashi)',
        },
        {
          song_type: 'Ending',
          titles: ['奏（かなで）'],
          artists: [{ names: ['Takagi-san (Rie Takahashi)'] }],
        },
      ),
    ).toBe(true);
  });

  it('matches romanized titles and CV credits across naming styles', () => {
    expect(
      malThemeMatchesAniplaylistHit(
        {
          type: 'Ending',
          title: 'Over Drive',
          artist: 'Takagi-san (Rie Takahashi)',
        },
        {
          song_type: 'Ending',
          titles: ['Over Drive'],
          artists: [{ names: ['Takagi-san (Rie Takahashi)'] }],
        },
      ),
    ).toBe(true);
  });

  it('matches on strong title alone when artist romanization differs', () => {
    expect(
      malThemeMatchesAniplaylistHit(
        {
          type: 'Opening',
          title: 'Zero Centimeter',
          artist: 'Yuiko Oohara',
        },
        {
          song_type: 'Opening',
          titles: ['Zero Centimeter'],
          artists: [{ names: ['Yuiko Ohara'] }],
        },
      ),
    ).toBe(true);
  });

  it('does not match different songs that only share a substring title', () => {
    expect(
      malThemeMatchesAniplaylistHit(
        {
          type: 'Opening',
          title: 'Zero',
          artist: 'Yuiko Oohara',
        },
        {
          song_type: 'Opening',
          titles: ['Zero Centimeter'],
          artists: [{ names: ['Yuiko Oohara'] }],
        },
      ),
    ).toBe(false);
  });

  it('matches when AniPlaylist lists the romaji title alongside Japanese', () => {
    expect(
      malThemeMatchesAniplaylistHit(
        {
          type: 'Opening',
          title: 'Zero Centimeter',
          artist: 'Yuiko Oohara',
        },
        {
          song_type: 'Opening',
          titles: ['零センチメートル', 'Zero Centimeter'],
          artists: [{ names: ['大原ゆい子'] }],
        },
      ),
    ).toBe(true);
  });
});
