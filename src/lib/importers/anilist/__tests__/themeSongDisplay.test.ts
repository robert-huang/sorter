import { describe, expect, it } from 'vitest';
import {
  extractNativeFromMalText,
  pickBestNativeCandidate,
  resolveThemeSongArtist,
  resolveThemeSongTitle,
  stripNativeParenthetical,
  themeSongEpisodeLine,
  themeSongInsertEpisodeLine,
  themeSongTypeBadge,
  groupThemeRowsByType,
} from '../themeSongs/themeSongDisplay';
import type { MediaThemeSongRow } from '../themeSongs/types';

function row(partial: Partial<MediaThemeSongRow> & Pick<MediaThemeSongRow, 'type'>): MediaThemeSongRow {
  return {
    sortOrder: 0,
    displayTitle: 'Title',
    displayArtist: null,
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
    ...partial,
  };
}

describe('themeSongTypeBadge', () => {
  it('uses aniplaylist song_key for openings and endings', () => {
    expect(themeSongTypeBadge(row({ type: 'Opening', songKey: 'OP2' }))).toBe('OP2');
    expect(themeSongTypeBadge(row({ type: 'Ending', songKey: 'ED' }))).toBe('ED');
    expect(themeSongTypeBadge(row({ type: 'Ending', songKey: 'ED6 (ep 1)' }))).toBe('ED6');
  });

  it('allows multiple rows to share the same aniplaylist ED label', () => {
    const badge = themeSongTypeBadge(row({ type: 'Ending', songKey: 'ED1 (ep 1)', sortOrder: 1002 }));
    expect(badge).toBe('ED1');
  });

  it('shows IN for inserts regardless of song_key detail', () => {
    expect(themeSongTypeBadge(row({ type: 'Insert', songKey: 'IN ep 12' }))).toBe('IN');
  });

  it('falls back to sort order when song_key is missing', () => {
    expect(themeSongTypeBadge(row({ type: 'Opening', sortOrder: 0 }))).toBe('OP');
    expect(themeSongTypeBadge(row({ type: 'Opening', sortOrder: 1 }))).toBe('OP2');
    expect(themeSongTypeBadge(row({ type: 'Ending', sortOrder: 2 }))).toBe('ED3');
  });
});

describe('themeSongEpisodeLine', () => {
  it('parses episode text from aniplaylist insert song_key', () => {
    expect(
      themeSongEpisodeLine(row({ type: 'Insert', songKey: 'IN ep 12' })),
    ).toBe('ep 12');
    expect(
      themeSongEpisodeLine(row({ type: 'Insert', songKey: 'IN ep 4 & 12' })),
    ).toBe('ep 4 & 12');
  });

  it('parses episode suffix from aniplaylist OP/ED song_key', () => {
    expect(
      themeSongEpisodeLine(row({ type: 'Ending', songKey: 'ED6 (ep 1)' })),
    ).toBe('ep 1');
    expect(
      themeSongEpisodeLine(row({ type: 'Ending', songKey: 'ED2 (eps 3-4)' })),
    ).toBe('eps 3-4');
    expect(themeSongEpisodeLine(row({ type: 'Opening', songKey: 'OP' }))).toBeNull();
  });

  it('falls back to mal episode text', () => {
    expect(
      themeSongEpisodeLine(
        row({ type: 'Insert', malEpisodes: 'Episode 5' }),
      ),
    ).toBe('Episode 5');
    expect(
      themeSongEpisodeLine(row({ type: 'Ending', malEpisodes: 'eps 1-12' })),
    ).toBe('eps 1-12');
  });
});

describe('themeSongInsertEpisodeLine', () => {
  it('only returns lines for inserts', () => {
    expect(
      themeSongInsertEpisodeLine(row({ type: 'Insert', songKey: 'IN ep 12' })),
    ).toBe('ep 12');
    expect(
      themeSongInsertEpisodeLine(row({ type: 'Ending', songKey: 'ED6 (ep 1)' })),
    ).toBeNull();
  });
});

describe('native theme song labels', () => {
  it('strips native parentheticals in english mode', () => {
    const themed = row({
      type: 'Ending',
      displayTitle: 'Kanjou Glass (感情グラス)',
      malTitle: 'Kanjou Glass (感情グラス)',
    });
    expect(resolveThemeSongTitle(themed, 'english')).toBe('Kanjou Glass');
  });

  it('prefers aniplaylist native titles in native mode', () => {
    const themed = row({
      type: 'Ending',
      displayTitle: 'Kanjou Glass (感情グラス)',
      malTitle: 'Kanjou Glass (感情グラス)',
      aniTitles: ['Kanjou Glass', '感情グラス'],
    });
    expect(resolveThemeSongTitle(themed, 'native')).toBe('感情グラス');
  });

  it('extracts nested native text from mal titles', () => {
    expect(extractNativeFromMalText('Kanade (奏（かなで）)')).toBe('奏（かなで）');
    expect(stripNativeParenthetical('Kanade (奏（かなで）)')).toBe('Kanade');
  });

  it('picks the most CJK-heavy candidate', () => {
    expect(pickBestNativeCandidate(['Kanjou Glass', '感情グラス', 'Glass'])).toBe('感情グラス');
  });

  it('resolves native artist from aniplaylist names', () => {
    const themed = row({
      type: 'Opening',
      displayArtist: 'Chin-lan Chang (CV: Maki Kawase)',
      aniArtists: ['Chin-lan Chang', 'チン・ラン・チャン'],
    });
    expect(resolveThemeSongArtist(themed, 'native')).toBe('チン・ラン・チャン');
  });
});

describe('groupThemeRowsByType', () => {
  it('groups rows by theme type', () => {
    const groups = groupThemeRowsByType([
      row({ type: 'Ending', displayTitle: 'ED' }),
      row({ type: 'Opening', displayTitle: 'OP' }),
      row({ type: 'Insert', displayTitle: 'IN' }),
    ]);
    expect(groups.Opening.map((r) => r.displayTitle)).toEqual(['OP']);
    expect(groups.Ending.map((r) => r.displayTitle)).toEqual(['ED']);
    expect(groups.Insert.map((r) => r.displayTitle)).toEqual(['IN']);
  });
});
