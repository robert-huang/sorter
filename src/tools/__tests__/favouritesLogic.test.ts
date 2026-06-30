import { describe, expect, it } from 'vitest';
import {
  accumulateVaStats,
  buildBirthdayCalendarLayout,
  buildFavouritesResult,
  buildVaPercentRankRows,
  CharacterRoleTier,
  countMainRoleVaCharacters,
  countVaCharactersOnMedia,
  formatBirthdayKey,
  MAIN_ROLE_PERCENT_DUMMY,
  pickCharacterName,
  processCharacterEdges,
} from '../panels/favouritesLogic';

describe('pickCharacterName', () => {
  it('prefers native when character display mode is native', () => {
    expect(
      pickCharacterName(
        { id: 1, name: { full: 'Romaji', native: 'ネイティブ' } },
        'native',
      ),
    ).toBe('ネイティブ');
  });

  it('uses full when character display mode is full', () => {
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
    expect(result.vas).toEqual([{ id: 10, name: 'VA One', imageUrl: null }]);
    expect(result.shows[1]).toEqual({
      title: 'Show A',
      coverImage: null,
      characters: [{ id: 99, name: 'Hero' }],
    });
  });

  it('groups manga edges into books when manga is on the user list', () => {
    const result = processCharacterEdges(
      99,
      'Hero',
      [
        {
          node: { id: 50, title: { romaji: 'Manga A', native: null }, type: 'MANGA' },
          characterRole: 'MAIN',
          voiceActors: [{ id: 10, name: { full: 'VA One', native: null } }],
        },
      ],
      new Set([50]),
    );

    expect(result.books[50]).toEqual({
      title: 'Manga A',
      coverImage: null,
      characters: [{ id: 99, name: 'Hero' }],
    });
    expect(result.shows).toEqual({});
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

  it('counts only characters whose best role on seen media is MAIN', () => {
    const count = countVaCharactersOnMedia(
      [
        {
          node: { id: 1 },
          characterRole: 'SUPPORTING',
          characters: [{ id: 100 }],
        },
        {
          node: { id: 2 },
          characterRole: 'MAIN',
          characters: [{ id: 101 }],
        },
        {
          node: { id: 3 },
          characterRole: 'SUPPORTING',
          characters: [{ id: 102 }],
        },
        {
          node: { id: 1 },
          characterRole: 'MAIN',
          characters: [{ id: 100 }],
        },
      ],
      new Set([1, 2, 3]),
      'mainOnly',
    );
    expect(count).toBe(2);
  });
});

describe('buildBirthdayCalendarLayout', () => {
  it('lays out months continuously from January 1 in column 0', () => {
    const layout = buildBirthdayCalendarLayout({
      '0101': [{ id: 1, name: 'New Year' }],
      '0201': [{ id: 2, name: 'Feb' }],
      '1231': [{ id: 3, name: 'Eve' }],
    });

    expect(layout.cells[0]).toMatchObject({ month: 1, day: 1, linearIndex: 0 });
    expect(layout.cells[0]?.characters).toEqual([{ id: 1, name: 'New Year' }]);
    expect(layout.cells[31]).toMatchObject({ month: 2, day: 1, linearIndex: 31 });
    expect(layout.cells[layout.cells.length - 1]).toMatchObject({ month: 12, day: 31 });
    expect(layout.incomplete).toEqual([]);
  });
});

describe('buildVaPercentRankRows', () => {
  it('recomputes favourited counts for main-role-only mode', () => {
    const byCount = [
      {
        staffId: 10,
        name: 'VA A',
        imageUrl: null,
        displayValue: '2',
        numericValue: 2,
        characters: [
          { id: 1, name: 'Main' },
          { id: 2, name: 'Supporting' },
        ],
      },
    ];
    const rows = buildVaPercentRankRows(
      byCount,
      {
        vaTotalCharacterCounts: { 10: 20 },
        vaMainRoleCharacterCounts: { 10: 5 },
        characterRoleTierById: {
          1: CharacterRoleTier.Main,
          2: CharacterRoleTier.Supporting,
        },
        characterCount: 20,
      },
      'mainOnly',
    );

    expect(rows[0]?.displayValue).toBe('20% (1/5)');
    expect(rows[0]?.characters).toEqual([{ id: 1, name: 'Main' }]);
    expect(rows[0]?.numericValue).toBeCloseTo(1 / (5 + MAIN_ROLE_PERCENT_DUMMY), 5);
  });

  it('uses total favourite count for sort dampening in all-roles mode', () => {
    const byCount = [
      {
        staffId: 10,
        name: 'VA A',
        imageUrl: null,
        displayValue: '2',
        numericValue: 2,
        characters: [
          { id: 1, name: 'Main' },
          { id: 2, name: 'Supporting' },
        ],
      },
    ];
    const rows = buildVaPercentRankRows(
      byCount,
      {
        vaTotalCharacterCounts: { 10: 20 },
        vaMainRoleCharacterCounts: { 10: 5 },
        characterRoleTierById: {
          1: CharacterRoleTier.Main,
          2: CharacterRoleTier.Supporting,
        },
        characterCount: 20,
      },
      'all',
    );

    expect(rows[0]?.numericValue).toBeCloseTo(2 / (20 + 2), 5);
  });
});

describe('countMainRoleVaCharacters', () => {
  it('counts a character as main when manga MAIN is best tier on consumed media', () => {
    const voicedCharacterIds = new Set([42]);
    const count = countMainRoleVaCharacters(voicedCharacterIds, [
      { characterId: 42, role: 'SUPPORTING' },
      { characterId: 42, role: 'MAIN' },
    ]);
    expect(count).toBe(1);
  });

  it('does not count when only supporting roles exist on consumed media', () => {
    const voicedCharacterIds = new Set([42]);
    const count = countMainRoleVaCharacters(voicedCharacterIds, [
      { characterId: 42, role: 'SUPPORTING' },
    ]);
    expect(count).toBe(0);
  });
});

describe('countVaCharactersOnMedia mainOnly vs countMainRoleVaCharacters', () => {
  it('edge-based mainOnly misses manga MAIN when VA filmography edge is supporting', () => {
    const consumed = new Set([100, 200]);
    const vaEdges = [
      {
        node: { id: 100 },
        characterRole: 'SUPPORTING',
        characters: [{ id: 42 }],
      },
    ];
    expect(countVaCharactersOnMedia(vaEdges, consumed, 'mainOnly')).toBe(0);
    expect(
      countMainRoleVaCharacters(new Set([42]), [
        { characterId: 42, role: 'SUPPORTING' },
        { characterId: 42, role: 'MAIN' },
      ]),
    ).toBe(1);
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
      [[{ id: 5, name: 'VA', imageUrl: null }], [{ id: 5, name: 'VA', imageUrl: null }]],
      'full',
    );
    const va = accum.get(5);
    expect(va).toBeDefined();
    // dummy = 0.2, two hits => raw count 2, stored count 2.2
    expect(va!.count).toBeCloseTo(2.2, 5);
    expect(va!.characters).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
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
        [{ id: 10, name: 'VA A', imageUrl: null }],
        [
          { id: 10, name: 'VA A', imageUrl: null },
          { id: 11, name: 'VA B', imageUrl: null },
        ],
      ],
      perCharacterMeta: [
        {
          charRole: CharacterRoleTier.Main,
          seen: true,
          isMain: true,
          shows: {
            1: { title: 'Show 1', coverImage: null, characters: [{ id: 1, name: 'Alice' }] },
          },
          books: {},
        },
        {
          charRole: CharacterRoleTier.Supporting,
          seen: true,
          isMain: false,
          shows: {
            2: { title: 'Show 2', coverImage: null, characters: [{ id: 2, name: 'Bob' }] },
          },
          books: {},
        },
      ],
      vaTotalCharacterCounts: new Map([
        [10, 20],
        [11, 5],
      ]),
      vaMainRoleCharacterCounts: new Map([
        [10, 8],
        [11, 2],
      ]),
      favouriteStaff: [{ id: 10, name: { full: 'VA A', native: null }, gender: 'Female' }],
    });

    expect(result.characterCount).toBe(2);
    expect(result.byCount[0].staffId).toBe(10);
    expect(result.gender.female).toEqual([{ id: 1, name: 'Alice' }]);
    expect(result.gender.male).toEqual([{ id: 2, name: 'Bob' }]);
    expect(result.numFemaleSeen).toBe(1);
    expect(result.numMain).toBe(1);
    expect(result.favouriteCharacters).toEqual([
      { id: 1, name: 'Alice', rank: 1, gender: 'Female' },
      { id: 2, name: 'Bob', rank: 2, gender: 'Male' },
    ]);
    expect(formatBirthdayKey(characters[0].dateOfBirth)).toBe('0305');
    expect(result.birthdays['0305']).toEqual([{ id: 1, name: 'Alice' }]);
    expect(result.favouriteStaff[0].matchedCount).toBe(2);
    expect(result.favouriteStaff[0].matchedCharacters).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
    expect(result.byCount.length).toBe(2);
  });

  it('builds seriesManga from per-character book metadata', () => {
    const result = buildFavouritesResult({
      characters: [
        {
          id: 1,
          name: { full: 'Alice', native: null },
          gender: 'Female',
          dateOfBirth: null,
        },
      ],
      perCharacterVas: [[{ id: 10, name: 'VA A', imageUrl: null }]],
      perCharacterMeta: [
        {
          charRole: CharacterRoleTier.Main,
          seen: true,
          isMain: true,
          shows: {},
          books: {
            50: {
              title: 'Manga A',
              coverImage: null,
              characters: [{ id: 1, name: 'Alice' }],
            },
          },
        },
      ],
      vaTotalCharacterCounts: new Map([[10, 1]]),
      vaMainRoleCharacterCounts: new Map([[10, 1]]),
      favouriteStaff: [],
    });

    expect(result.seriesManga).toEqual([
      expect.objectContaining({
        mediaId: 50,
        title: 'Manga A',
        mediaType: 'MANGA',
        characters: [{ id: 1, name: 'Alice' }],
      }),
    ]);
  });
});
