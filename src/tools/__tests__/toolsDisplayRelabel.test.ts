import { afterEach, describe, expect, it } from 'vitest';
import {
  pickLooseMediaTitle,
  relabelSeasonalShows,
  relabelStaffShowMap,
  resolveStaffDisplayNames,
  voiceRoleLabelSource,
} from '../toolsDisplayRelabel';
import type { SeasonalShow } from '../panels/seasonalScoresLogic';
import type { StaffShowMap } from '../panels/sharedCreditsLogic';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
  type MediaTitleDisplayMode,
} from '../../lib/importers/anilist/displayPreferences';

const ROMAJI: MediaTitleDisplayMode = 'romaji';
const ENGLISH: MediaTitleDisplayMode = 'english';
const NATIVE: MediaTitleDisplayMode = 'native';

function setTitleMode(mode: MediaTitleDisplayMode): void {
  saveAnilistDisplayPreferences({ mediaTitleMode: mode });
}

afterEach(() => {
  _clearAnilistDisplayPreferencesForTesting();
});

describe('resolveStaffDisplayNames', () => {
  it('picks full name by default and keeps id as the map key', () => {
    const names = resolveStaffDisplayNames({
      1: { id: 1, name_full: 'Hayao Miyazaki', name_native: '宮崎駿' },
      2: { id: 2, name_full: 'Mamoru Hosoda', name_native: '細田守' },
    });
    expect(names).toEqual({
      1: 'Hayao Miyazaki',
      2: 'Mamoru Hosoda',
    });
  });

  it('falls back to native when full is missing', () => {
    const names = resolveStaffDisplayNames({
      3: { id: 3, name_full: null, name_native: '新海誠' },
    });
    expect(names[3]).toBe('新海誠');
  });
});

describe('relabelSeasonalShows', () => {
  const base: SeasonalShow[] = [
    {
      id: 10,
      title: 'cached-stale',
      titleSource: {
        id: 10,
        title_english: 'Cowboy Bebop',
        title_romaji: 'Cowboy Bebop',
        title_native: 'カウボーイビバップ',
      },
    } as SeasonalShow,
    {
      id: 11,
      title: 'no-source-stays',
      // Title source omitted: legacy/incomplete row keeps stale title.
    } as SeasonalShow,
  ];

  it('relabels shows that carry a titleSource', () => {
    setTitleMode(ENGLISH);
    const out = relabelSeasonalShows(base);
    expect(out[0].title).toBe('Cowboy Bebop');
  });

  it('reflects the current display preference (native swap)', () => {
    setTitleMode(NATIVE);
    const out = relabelSeasonalShows(base);
    expect(out[0].title).toBe('カウボーイビバップ');
  });

  it('leaves shows without titleSource untouched (no clobber to "Untitled")', () => {
    setTitleMode(ENGLISH);
    const out = relabelSeasonalShows(base);
    expect(out[1].title).toBe('no-source-stays');
  });
});

describe('relabelStaffShowMap', () => {
  const map: StaffShowMap = {
    '20': {
      title: 'old-cached-title',
      coverImage: null,
      startDate: '2020-01-01',
      titleSource: {
        id: 20,
        title_english: 'Steins;Gate',
        title_romaji: 'Steins;Gate',
        title_native: 'シュタインズ・ゲート',
      },
      roles: [
        {
          label: 'old-role-label',
          labelSource: { kind: 'production', staffRole: 'Storyboard (ep 5)' },
        },
        {
          label: 'old-voice-label',
          labelSource: {
            kind: 'voice',
            characterId: 99,
            characterNameFull: 'Okabe Rintarou',
            characterNameNative: '岡部倫太郎',
            characterRole: 'Main',
          },
        },
      ],
    },
  };

  it('relabels show title from titleSource and rebuilds voice/production role labels', () => {
    setTitleMode(ENGLISH);
    const out = relabelStaffShowMap(map);
    expect(out['20'].title).toBe('Steins;Gate');
    expect(out['20'].roles[0].label).toBe('Storyboard (ep 5)');
    expect(out['20'].roles[1].label).toBe('Okabe Rintarou (Main)');
  });

  it('preserves source-less entries verbatim (no labelSource means no relabel)', () => {
    const out = relabelStaffShowMap({
      '21': {
        title: 'kept',
        coverImage: null,
        startDate: '',
        roles: [{ label: 'stays' }],
      },
    });
    expect(out['21'].title).toBe('kept');
    expect(out['21'].roles[0].label).toBe('stays');
  });
});

describe('pickLooseMediaTitle', () => {
  it('routes loose AniList title fields through the canonical picker', () => {
    setTitleMode(NATIVE);
    expect(
      pickLooseMediaTitle(1, { english: 'A', romaji: 'B', native: 'C' }),
    ).toBe('C');
    setTitleMode(ENGLISH);
    expect(
      pickLooseMediaTitle(1, { english: 'A', romaji: 'B', native: 'C' }),
    ).toBe('A');
  });

  it('falls back to Untitled (id) when all three are missing', () => {
    setTitleMode(ROMAJI);
    expect(pickLooseMediaTitle(42, {})).toBe('Untitled (42)');
  });
});

describe('voiceRoleLabelSource', () => {
  it('produces a voice-kind label source with verbatim character fields', () => {
    const source = voiceRoleLabelSource({
      characterId: 7,
      characterNameFull: 'Spike Spiegel',
      characterNameNative: 'スパイク・スピーゲル',
      characterRole: 'Main',
    });
    expect(source).toEqual({
      kind: 'voice',
      characterId: 7,
      characterNameFull: 'Spike Spiegel',
      characterNameNative: 'スパイク・スピーゲル',
      characterRole: 'Main',
    });
  });
});
