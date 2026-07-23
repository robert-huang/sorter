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
});

describe('parseMalThemes', () => {
  it('preserves opening and ending order', () => {
    const themes = parseMalThemes(['"OP Song" by Artist A'], ['"ED Song" by Artist B']);
    expect(themes).toHaveLength(2);
    expect(themes[0]?.type).toBe('Opening');
    expect(themes[1]?.type).toBe('Ending');
  });
});
