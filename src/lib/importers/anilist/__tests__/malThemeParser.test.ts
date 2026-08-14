import { describe, expect, it } from 'vitest';
import { parseMalThemeString, parseMalThemes } from '../themeSongs/malThemeParser';

describe('parseMalThemeString', () => {
  it('parses a simple opening', () => {
    const parsed = parseMalThemeString('"Zero Centimeter" by Yuiko Oohara', 'Opening', 0);
    expect(parsed).toMatchObject({
      type: 'Opening',
      sortOrder: 0,
      title: 'Zero Centimeter',
      artist: 'Yuiko Oohara',
      episodes: null,
    });
  });

  it('parses numbered endings with episodes', () => {
    const parsed = parseMalThemeString(
      '1: "Kanade (奏（かなで）)" by Takagi-san (Rie Takahashi) (eps 1)',
      'Ending',
      0,
    );
    expect(parsed).toMatchObject({
      type: 'Ending',
      sortOrder: 0,
      title: 'Kanade (奏（かなで）)',
      artist: 'Takagi-san (Rie Takahashi)',
      episodes: 'eps 1',
    });
  });

  it('parses platform labels that precede episode markers', () => {
    const parsed = parseMalThemeString(
      '1: "My Soul, Your Beats!" by Lia (TV: eps 2-3, 5-9, 11; BD/DVD: eps 1-3, 5-13)',
      'Opening',
      0,
    );
    expect(parsed).toMatchObject({
      type: 'Opening',
      sortOrder: 0,
      title: 'My Soul, Your Beats!',
      artist: 'Lia',
      episodes: 'TV: eps 2-3, 5-9, 11; BD/DVD: eps 1-3, 5-13',
    });
  });

  it('does not treat ordinary artist parentheticals as episode metadata', () => {
    const parsed = parseMalThemeString(
      '"Song" by Artist (Acoustic Version 2)',
      'Opening',
      0,
    );
    expect(parsed).toMatchObject({
      artist: 'Artist (Acoustic Version 2)',
      episodes: null,
    });
  });

  it('parses official MAL API hash-prefixed theme numbers', () => {
    const parsed = parseMalThemeString(
      '#1: "takt (タクト)" by ryo (supercell) feat. Mafumafu, gaku',
      'Opening',
      0,
    );
    expect(parsed).toMatchObject({
      type: 'Opening',
      sortOrder: 0,
      title: 'takt (タクト)',
      artist: 'ryo (supercell) feat. Mafumafu, gaku',
    });
  });

  it('strips doubled / mismatched quote wrappers from Jikan theme strings', () => {
    const parsed = parseMalThemeString(
      `''Soarin\u2019'' by Ginger Root`,
      'Ending',
      0,
    );
    expect(parsed).toMatchObject({
      title: 'Soarin',
      artist: 'Ginger Root',
    });
  });
});

describe('parseMalThemes', () => {
  it('preserves opening and ending order', () => {
    const themes = parseMalThemes(['"OP Song" by Artist A'], ['"ED Song" by Artist B']);
    expect(themes).toHaveLength(2);
    expect(themes[0]?.type).toBe('Opening');
    expect(themes[1]?.type).toBe('Ending');
  });
});
