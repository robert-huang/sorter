import { describe, expect, it } from 'vitest';
import { alignRoleCellsAcrossShows, alignVaRoleCellsAcrossShows } from '../toolsDictUtils';
import { trimProductionRole } from '../staffRoleBuckets';

describe('alignRoleCellsAcrossShows', () => {
  it('aligns matching roles on the same row using the first show as anchor', () => {
    expect(alignRoleCellsAcrossShows([['roleA', 'roleB'], ['roleB']])).toEqual([
      ['roleA', ''],
      ['roleB', 'roleB'],
    ]);
  });

  it('reorders other shows so shared roles line up with the anchor', () => {
    expect(alignRoleCellsAcrossShows([['roleB'], ['roleA', 'roleB']])).toEqual([
      ['roleB', 'roleB'],
      ['', 'roleA'],
    ]);
  });

  it('handles three shows with mixed overlap', () => {
    expect(
      alignRoleCellsAcrossShows([
        ['Director', 'Music'],
        ['Music'],
        ['Director', 'Script'],
      ]),
    ).toEqual([
      ['Director', '', 'Director'],
      ['Music', 'Music', ''],
      ['', '', 'Script'],
    ]);
  });

  it('aligns leftover roles that only appear on non-anchor shows', () => {
    expect(
      alignRoleCellsAcrossShows([
        ['Storyboard', 'Editing'],
        ['Storyboard', 'Image Board'],
        ['Storyboard', 'Editing', 'Image Board'],
      ]),
    ).toEqual([
      ['Storyboard', 'Storyboard', 'Storyboard'],
      ['Editing', '', 'Editing'],
      ['', 'Image Board', 'Image Board'],
    ]);
  });

  describe('with a normalize() override', () => {
    it('aligns role labels whose only difference is the parenthetical scope', () => {
      // Real-world Bakemonogatari / Nekomonogatari case: Yui Horie
      // performs different songs across the two shows, so AniList
      // labels the credits differently — but it's the same role.
      // The shared cells should keep their original labels so the
      // user can still see WHICH songs each show credits her with.
      expect(
        alignRoleCellsAcrossShows(
          [
            ['Theme Song Performance (OP5)'],
            ['Theme Song Performance (OP2a, OP2b)'],
          ],
          trimProductionRole,
        ),
      ).toEqual([
        ['Theme Song Performance (OP5)', 'Theme Song Performance (OP2a, OP2b)'],
      ]);
    });

    it('aligns "Animation Director (OP1, OP3)" with "Animation Director (eps 1-4)"', () => {
      expect(
        alignRoleCellsAcrossShows(
          [['Animation Director (OP1, OP3)'], ['Animation Director (eps 1-4)']],
          trimProductionRole,
        ),
      ).toEqual([['Animation Director (OP1, OP3)', 'Animation Director (eps 1-4)']]);
    });

    it('prefers an exact match over a fuzzy match when both are available', () => {
      // Anchor's first role exactly matches show 2's second role; the
      // fuzzy match (show 2's first role) shouldn't steal that pairing.
      // The fuzzy match still lands the leftover anchor role on the same
      // row instead of splitting into two.
      expect(
        alignRoleCellsAcrossShows(
          [
            ['Animation Director (OP1)', 'Animation Director (eps 1-2)'],
            ['Animation Director (eps 1-2)', 'Animation Director (OP1)'],
          ],
          trimProductionRole,
        ),
      ).toEqual([
        ['Animation Director (OP1)', 'Animation Director (OP1)'],
        ['Animation Director (eps 1-2)', 'Animation Director (eps 1-2)'],
      ]);
    });

    it('still cross-aligns when a fuzzy-only match shows up on non-anchor shows', () => {
      // Anchor has no Animation Director credit; the other two shows
      // each have one but with different parentheticals. Phase 2
      // (leftover handling) should cluster them on the same row.
      expect(
        alignRoleCellsAcrossShows(
          [
            ['Storyboard'],
            ['Animation Director (OP1)'],
            ['Animation Director (eps 5-7)'],
          ],
          trimProductionRole,
        ),
      ).toEqual([
        ['Storyboard', '', ''],
        ['', 'Animation Director (OP1)', 'Animation Director (eps 5-7)'],
      ]);
    });

    it('keeps distinct roles on separate rows even after trimming', () => {
      // "Sound Director" trims to "Sound", "Animation Director" trims to
      // "Animation" — they must not collapse into one another.
      expect(
        alignRoleCellsAcrossShows(
          [['Sound Director (OP1)', 'Animation Director (eps 1)'], ['Sound Director (OP2)']],
          trimProductionRole,
        ),
      ).toEqual([
        ['Sound Director (OP1)', 'Sound Director (OP2)'],
        ['Animation Director (eps 1)', ''],
      ]);
    });

    it('default (no normalize) preserves the original exact-string behaviour', () => {
      // Sanity check: identical to the pre-existing two-show case.
      expect(alignRoleCellsAcrossShows([['roleA', 'roleB'], ['roleB']])).toEqual([
        ['roleA', ''],
        ['roleB', 'roleB'],
      ]);
    });
  });
});

describe('alignVaRoleCellsAcrossShows', () => {
  it('aligns roles with the same character id even when cast role differs', () => {
    expect(
      alignVaRoleCellsAcrossShows([
        [{ characterId: 100, label: 'MAIN Alice' }],
        [{ characterId: 100, label: 'SUPPORTING Alice' }],
      ]),
    ).toEqual([['MAIN Alice', 'SUPPORTING Alice']]);
  });

  it('keeps different characters on separate rows', () => {
    expect(
      alignVaRoleCellsAcrossShows([
        [
          { characterId: 100, label: 'MAIN Alice' },
          { characterId: 200, label: 'MAIN Bob' },
        ],
        [
          { characterId: 200, label: 'MAIN Bob' },
          { characterId: 100, label: 'BACKGROUND Alice' },
        ],
      ]),
    ).toEqual([
      ['MAIN Alice', 'BACKGROUND Alice'],
      ['MAIN Bob', 'MAIN Bob'],
    ]);
  });

  it('aligns the same character id across non-anchor shows when the anchor lacks it', () => {
    const yukinoId = 88530;
    expect(
      alignVaRoleCellsAcrossShows([
        [{ characterId: 1, label: 'MAIN Hodaka Morishima' }],
        [
          { characterId: 2, label: 'MAIN Mitsuha Miyamizu' },
          { characterId: yukinoId, label: 'BACKGROUND Yukari Yukino' },
        ],
        [
          { characterId: yukinoId, label: 'MAIN Yukari Yukino' },
          { characterId: 3, label: 'MAIN Takao Akizuki' },
        ],
      ]),
    ).toEqual([
      ['MAIN Hodaka Morishima', '', ''],
      ['', 'MAIN Mitsuha Miyamizu', ''],
      ['', 'BACKGROUND Yukari Yukino', 'MAIN Yukari Yukino'],
      ['', '', 'MAIN Takao Akizuki'],
    ]);
  });
});
