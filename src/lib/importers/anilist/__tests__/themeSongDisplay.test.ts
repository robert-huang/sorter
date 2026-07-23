import { describe, expect, it } from 'vitest';
import {
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

describe('themeSongInsertEpisodeLine', () => {
  it('parses episode text from aniplaylist song_key', () => {
    expect(
      themeSongInsertEpisodeLine(row({ type: 'Insert', songKey: 'IN ep 12' })),
    ).toBe('ep 12');
    expect(
      themeSongInsertEpisodeLine(row({ type: 'Insert', songKey: 'IN ep 4 & 12' })),
    ).toBe('ep 4 & 12');
  });

  it('falls back to mal episode text', () => {
    expect(
      themeSongInsertEpisodeLine(
        row({ type: 'Insert', malEpisodes: 'Episode 5' }),
      ),
    ).toBe('Episode 5');
  });

  it('returns null for non-insert rows', () => {
    expect(themeSongInsertEpisodeLine(row({ type: 'Opening', songKey: 'OP' }))).toBeNull();
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
