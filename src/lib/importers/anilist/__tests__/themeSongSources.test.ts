import { describe, expect, it } from 'vitest';
import {
  allThemeSongSourcesFailed,
  failedSource,
  okSource,
  themeSongsSourceNotes,
} from '../themeSongs/themeSongSources';

describe('themeSongsSourceNotes', () => {
  it('returns notes for failed sources with detail', () => {
    const notes = themeSongsSourceNotes({
      jikan: failedSource('themes 504, full 504'),
      aniplaylist: failedSource('403'),
    });
    expect(notes).toContain('MAL theme data unavailable (themes 504, full 504).');
    expect(notes).toContain('AniPlaylist unavailable (403) — Spotify links not enriched.');
  });

  it('returns empty when both ok', () => {
    expect(
      themeSongsSourceNotes({
        jikan: okSource(),
        aniplaylist: okSource(),
      }),
    ).toEqual([]);
  });
});

describe('allThemeSongSourcesFailed', () => {
  it('is true only when both sources failed', () => {
    expect(
      allThemeSongSourcesFailed({
        jikan: failedSource('504'),
        aniplaylist: failedSource('403'),
      }),
    ).toBe(true);
    expect(
      allThemeSongSourcesFailed({
        jikan: okSource(),
        aniplaylist: failedSource('403'),
      }),
    ).toBe(false);
  });
});
