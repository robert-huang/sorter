import { describe, expect, it } from 'vitest';
import { parseMalThemes } from '../themeSongs/malThemeParser';
import {
  artistsRoughlyMatch,
  mergeThemeSongs,
  sortOrderFromAniplaylistSongKey,
} from '../themeSongs/mergeThemeSongs';
import type { AniplaylistHit } from '../themeSongs/aniplaylistApi';

describe('artistsRoughlyMatch', () => {
  it('matches flipped Latin name order with shared CV credit', () => {
    expect(
      artistsRoughlyMatch(
        'Chin-lan Chang (CV: Maki Kawase)',
        'Chang Chin-lan (CV: Maki Kawase)',
      ),
    ).toBe(true);
  });

  it('does not match different performers on the same title', () => {
    expect(artistsRoughlyMatch('Artist A', 'Artist B')).toBe(false);
  });
});

describe('sortOrderFromAniplaylistSongKey', () => {
  it('maps ED6 to sort order 5', () => {
    expect(sortOrderFromAniplaylistSongKey('ED6', 'Ending')).toBe(5);
  });

  it('parses ED prefix before episode suffix', () => {
    expect(sortOrderFromAniplaylistSongKey('ED6 (ep 1)', 'Ending')).toBe(5);
  });
});

describe('mergeThemeSongs', () => {
  it('outer-joins mal-only and aniplaylist-only rows', () => {
    const mal = parseMalThemes(['"Only MAL" by Singer'], []);
    const aniHit: AniplaylistHit = {
      id: 1,
      anime_id: 99,
      score: 50,
      titles: ['Only AniPlaylist'],
      song_key: 'IN ep 11',
      song_type: 'Insert',
      artists: [{ names: ['Band'] }],
      links: [],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows.some((r) => r.displayTitle === 'Only MAL')).toBe(true);
    expect(rows.some((r) => r.displayTitle === 'Only AniPlaylist')).toBe(true);
  });

  it('merges matching mal and aniplaylist rows', () => {
    const mal = parseMalThemes(['"Kore Kaite Shine" by BURNOUT SYNDROMES'], []);
    const aniHit: AniplaylistHit = {
      id: 2,
      anime_id: 100,
      score: 60,
      titles: ['Kore Kaite Shine'],
      song_key: 'OP',
      song_type: 'Opening',
      artists: [{ names: ['BURNOUT SYNDROMES'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/0xiPPtrQgUp9dB0Z3oQ3x8',
        },
      ],
      other_link_ids: ['0xiPPtrQgUp9dB0Z3oQ3x8'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.songKey).toBe('OP');
    expect(rows[0]?.malTitle).toBe('Kore Kaite Shine');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('merges when aniplaylist artist name order differs from MAL', () => {
    const mal = parseMalThemes(
      [],
      ['6: "Kanjou Glass (感情グラス)" by Chin-lan Chang (CV: Maki Kawase)'],
    );
    const aniHit: AniplaylistHit = {
      id: 3,
      anime_id: 101,
      score: 55,
      titles: ['Kanjou Glass'],
      song_key: 'ED6',
      song_type: 'Ending',
      artists: [{ names: ['Chang Chin-lan (CV: Maki Kawase)'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/abc123def456ghi789jkl',
        },
      ],
      other_link_ids: ['abc123def456ghi789jkl'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.malTitle).toBe('Kanjou Glass (感情グラス)');
    expect(rows[0]?.songKey).toBe('ED6');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('uses aniplaylist song_key sort order for orphan rows', () => {
    const aniHit: AniplaylistHit = {
      id: 4,
      anime_id: 102,
      score: 40,
      titles: ['Orphan ED'],
      song_key: 'ED6',
      song_type: 'Ending',
      artists: [{ names: ['Singer'] }],
      links: [],
    };

    const rows = mergeThemeSongs([], [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sortOrder).toBe(5);
    expect(rows[0]?.songKey).toBe('ED6');
  });

  it('uses aniplaylist labels for orphans when MAL is missing', () => {
    const hits: AniplaylistHit[] = [
      {
        id: 10,
        anime_id: 38993,
        score: 50,
        titles: ['Kanade'],
        song_key: 'ED1 (ep 1)',
        song_type: 'Ending',
        artists: [{ names: ['Takagi-san'] }],
        links: [],
      },
      {
        id: 11,
        anime_id: 38993,
        score: 49,
        titles: ['Konayuki'],
        song_key: 'ED2 (ep 2)',
        song_type: 'Ending',
        artists: [{ names: ['Takagi-san'] }],
        links: [],
      },
    ];

    const rows = mergeThemeSongs([], hits);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
    expect(rows.every((r) => r.sortOrder < 100)).toBe(true);
  });
});
