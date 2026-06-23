import { describe, expect, it } from 'vitest';
import { alignRoleCellsAcrossShows } from '../toolsDictUtils';

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
});
