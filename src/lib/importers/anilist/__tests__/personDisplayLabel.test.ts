import { describe, expect, it } from 'vitest';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../displayPreferences';
import {
  characterNameSearchParts,
  personNameSearchParts,
  pickPersonName,
} from '../personDisplayLabel';

const FIELDS = {
  id: 10,
  name_full: 'Yui Horie',
  name_native: '堀江由衣',
};

describe('pickPersonName', () => {
  it('prefers full name when display mode is full', () => {
    _clearAnilistDisplayPreferencesForTesting();
    saveAnilistDisplayPreferences({ personNameMode: 'full' });
    expect(pickPersonName(FIELDS)).toBe('Yui Horie');
  });

  it('prefers native name when display mode is native', () => {
    saveAnilistDisplayPreferences({ personNameMode: 'native' });
    expect(pickPersonName(FIELDS)).toBe('堀江由衣');
  });
});

describe('personNameSearchParts', () => {
  it('includes both full and native names', () => {
    expect(personNameSearchParts(FIELDS)).toEqual(['Yui Horie', '堀江由衣']);
  });

  it('folds in extra names and dedupes', () => {
    expect(
      personNameSearchParts(FIELDS, ['Yui Horie', 'Horiemon', null, undefined]),
    ).toEqual(['Yui Horie', '堀江由衣', 'Horiemon']);
  });
});

describe('characterNameSearchParts', () => {
  it('includes full, native, alternatives and spoiler alternatives', () => {
    expect(
      characterNameSearchParts({
        id: 20,
        name_full: 'Lelouch Lamperouge',
        name_native: 'ルルーシュ・ランペルージ',
        name_alternatives_json: '["Lelouch vi Britannia", "Zero"]',
        name_alternatives_spoiler_json: '["Eleventh Prince"]',
      }),
    ).toEqual([
      'Lelouch Lamperouge',
      'ルルーシュ・ランペルージ',
      'Lelouch vi Britannia',
      'Zero',
      'Eleventh Prince',
    ]);
  });

  it('tolerates null / malformed alternatives json', () => {
    expect(
      characterNameSearchParts({
        id: 21,
        name_full: 'Faye Valentine',
        name_native: null,
        name_alternatives_json: 'not json',
        name_alternatives_spoiler_json: null,
      }),
    ).toEqual(['Faye Valentine']);
  });
});
