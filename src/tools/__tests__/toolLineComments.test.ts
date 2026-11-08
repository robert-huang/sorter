import { describe, expect, it } from 'vitest';
import {
  splitToolComments,
  stripToolComments,
  toggleLineComments,
  toolCommentsOnly,
  withToolComments,
} from '../toolLineComments';
import { parseShowInputs } from '../panels/sharedStaffLogic';
import { parseStaffInputs } from '../panels/sharedCreditsLogic';
import { textWithUnstagedQueries } from '../ToolQueryStaging';

function applyToggle(text: string, start: number, end = start) {
  const edit = toggleLineComments(text, start, end);
  return {
    text: text.slice(0, edit.from) + edit.replacement + text.slice(edit.to),
    start: edit.selectionStart,
    end: edit.selectionEnd,
  };
}

describe('splitToolComments', () => {
  it('skips // lines, including indented ones', () => {
    expect(splitToolComments('Heat\n// Alien\n   //Up\nAkira')).toEqual({
      live: ['Heat', 'Akira'],
      comments: ['// Alien', '   //Up'],
    });
  });

  it('skips /* */ blocks across lines and on one line', () => {
    const text = 'A\n/* saved\nB\nC */\nD\n/* E */\nF';
    expect(splitToolComments(text).live).toEqual(['A', 'D', 'F']);
  });

  it('an unclosed block runs to the end', () => {
    expect(stripToolComments('A\n/* later\nB\nC')).toBe('A');
  });

  it('a lone /*/ does not close itself', () => {
    expect(stripToolComments('/*/\nB\n*/\nC')).toBe('C');
  });

  it('keeps titles that contain the markers mid-line', () => {
    const titles = [
      '.hack//Sign',
      '.hack//Roots',
      '.hack//G.U. Trilogy',
      'Fate/stay night',
      'Fate/Zero',
      'Steins;Gate 0',
      'Re:Zero − Starting Life in Another World',
      '22/7',
      'Ghost in the Shell: S.A.C. 2nd GIG',
      'Kaguya-sama: Love is War *',
      'https://anilist.co/anime/1',
    ];
    expect(parseShowInputs(titles.join('\n'))).toEqual(titles);
  });

  it('a title ending in */ outside a block is a normal line', () => {
    expect(stripToolComments('A */\nB')).toBe('A */\nB');
  });

  it('applies to both shared tools, after BOM and format-suffix handling', () => {
    expect(parseShowInputs('\uFEFF// skip\nHeat (MOVIE)\n/* x */\nAlien')).toEqual([
      'Heat',
      'Alien',
    ]);
    expect(parseStaffInputs('Kana Hanazawa\n// Yuki Kaji\n12345', true)).toEqual([
      'Kana Hanazawa',
      '12345',
    ]);
  });
});

describe('staging keeps saved comments', () => {
  it('Add to staged leaves only the comments', () => {
    expect(toolCommentsOnly('Heat\n// later\n/* a\nb */\nAlien')).toBe('// later\n/* a\nb */');
  });

  it('Clear staged puts the queries back above the comments', () => {
    const text = '// later\nAlien';
    expect(
      withToolComments(textWithUnstagedQueries(['Heat'], parseShowInputs(text)), text),
    ).toBe('Heat\nAlien\n// later');
    expect(withToolComments('', '// only')).toBe('// only');
    expect(withToolComments('Heat', 'Heat')).toBe('Heat');
  });
});

describe('toggleLineComments', () => {
  it('comments and uncomments the caret line, keeping the caret on its text', () => {
    const on = applyToggle('Heat\nAlien\nAkira', 7);
    expect(on.text).toBe('Heat\n// Alien\nAkira');
    expect(on.start).toBe(10);
    const off = applyToggle(on.text, on.start);
    expect(off.text).toBe('Heat\nAlien\nAkira');
    expect(off.start).toBe(7);
  });

  it('comments every selected line and skips blank ones', () => {
    const text = 'A\n\nB\nC';
    const on = applyToggle(text, 0, text.indexOf('B') + 1);
    expect(on.text).toBe('// A\n\n// B\nC');
    expect(on.text.slice(on.start, on.end)).toBe('// A\n\n// B');
  });

  it('a selection ending at the start of a line leaves that line alone', () => {
    expect(applyToggle('A\nB\nC', 0, 2).text).toBe('// A\nB\nC');
  });

  it('uncomments only when every selected line is commented', () => {
    expect(applyToggle('// A\nB', 0, 6).text).toBe('// // A\n// B');
    expect(applyToggle('// A\n  //B', 0, 10).text).toBe('A\n  B');
  });

  it('comments an empty line so the caret has somewhere to type', () => {
    const on = applyToggle('', 0);
    expect(on.text).toBe('// ');
    expect(on.start).toBe(3);
  });

  it('keeps indentation in front of the marker', () => {
    expect(applyToggle('  Heat', 3).text).toBe('  // Heat');
  });

  it('never moves the caret before its line when uncommenting', () => {
    const off = applyToggle('A\n// B', 3);
    expect(off.text).toBe('A\nB');
    expect(off.start).toBe(2);
  });
});
