import { describe, expect, it } from 'vitest';
import { alignRoleCellsAcrossShows, alignVaRoleCellsAcrossShows } from '../toolsDictUtils';

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
});
