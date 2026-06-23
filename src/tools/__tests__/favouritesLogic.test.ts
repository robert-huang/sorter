import { describe, expect, it } from 'vitest';
import {
  accumulateVaStats,
  buildFavouritesResult,
  CharacterRoleTier,
  countVaCharactersOnMedia,
  formatBirthdayKey,
  pickCharacterName,
  processCharacterEdges,
} from '../panels/favouritesLogic';

describe('pickCharacterName', () => {
  it('prefers native when person display mode is native', () => {
    expect(
      pickCharacterName(
        { id: 1, name: { full: 'Romaji', native: 'ネイティブ' } },
        'native',
      ),
    ).toBe('ネイティブ');
  });

  it('uses full when person display mode is full', () => {
    expect(
      pickCharacterName(
        { id: 1, name: { full: 'Romaji', native: 'ネイティブ' } },
        'full',
      ),
    ).toBe('Romaji');
  });
});

describe('processCharacterEdges', () => {
  const consumed = new Set([1, 2]);

  it('skips media not on user list and blacklisted ids', () => {
    const result = processCharacterEdges(
      99,
      'Hero',
      [
        {
          node: { id: 1, title: { romaji: 'Show A', native: null }, type: 'ANIME' },
          characterRole: 'MAIN',
          voiceActors: [{ id: 10, name: { full: 'VA One', native: null } }],
        },
        {
          node: { id: 999, title: { romaji: 'Unseen', native: null }, type: 'ANIME' },
          characterRole: 'MAIN',
          voiceActors: [{ id: 11, name: { full: 'VA Two', native: null } }],
        },
      ],
      consumed,
    );

    expect(result.seen).toBe(true);
    expect(result.isMain).toBe(true);
    expect(result.charRole).toBe(CharacterRoleTier.Main);
    expect(result.vas).toEqual([{ id: 10, name: 'VA One' }]);
    expect(result.shows['Show A']).toEqual(['Hero']);
  });
});

describe('countVaCharactersOnMedia', () => {
  it('dedupes characters and ignores unseen media', () => {
    const count = countVaCharactersOnMedia(
      [
        { node: { id: 1 }, characters: [{ id: 100 }, { id: 100 }, null] },
        { node: { id: 2 }, characters: [{ id: 101 }] },
        { node: { id: 3 }, characters: [{ id: 102 }] },
      ],
      new Set([1, 2]),
    );
    expect(count).toBe(2);
  });
});

describe('accumulateVaStats', () => {
  it('applies Bayesian dummy median and rank weighting', () => {
    const characters = [
      { id: 1, name: { full: 'A', native: null } },
      { id: 2, name: { full: 'B', native: null } },
    ];
    const accum = accumulateVaStats(
      characters,
      [[{ id: 5, name: 'VA' }], [{ id: 5, name: 'VA' }]],
      'full',
    );
    const va = accum.get(5);
    expect(va).toBeDefined();
    // dummy = 0.2, two hits => raw count 2, stored count 2.2
    expect(va!.count).toBeCloseTo(2.2, 5);
    expect(va!.characterNames).toEqual(['A', 'B']);
  });
});

describe('buildFavouritesResult', () => {
  it('builds top VA rows and gender buckets', () => {
    const characters = [
      {
        id: 1,
        name: { full: 'Alice', native: null },
        gender: 'Female',
        dateOfBirth: { month: 3, day: 5 },
      },
      {
        id: 2,
        name: { full: 'Bob', native: null },
        gender: 'Male',
        dateOfBirth: null,
      },
    ];

    const result = buildFavouritesResult({
      characters,
      perCharacterVas: [
        [{ id: 10, name: 'VA A' }],
        [{ id: 10, name: 'VA A' }, { id: 11, name: 'VA B' }],
      ],
      perCharacterMeta: [
        {
          charRole: CharacterRoleTier.Main,
          seen: true,
          isMain: true,
          shows: { 'Show 1': ['Alice'] },
          books: {},
        },
        {
          charRole: CharacterRoleTier.Supporting,
          seen: true,
          isMain: false,
          shows: { 'Show 2': ['Bob'] },
          books: {},
        },
      ],
      vaTotalCharacterCounts: new Map([
        [10, 20],
        [11, 5],
      ]),
      favouriteStaff: [{ id: 10, name: { full: 'VA A', native: null }, gender: 'Female' }],
      topN: 5,
    });

    expect(result.characterCount).toBe(2);
    expect(result.byCount[0].staffId).toBe(10);
    expect(result.gender.female).toEqual(['Alice']);
    expect(result.gender.male).toEqual(['Bob']);
    expect(formatBirthdayKey(characters[0].dateOfBirth)).toBe('0305');
    expect(result.birthdays['0305']).toEqual(['Alice']);
    expect(result.favouriteStaff[0].matchedCount).toBe(2);
  });
});
