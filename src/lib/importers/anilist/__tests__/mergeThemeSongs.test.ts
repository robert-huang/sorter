import { describe, expect, it } from 'vitest';
import { parseMalThemes } from '../themeSongs/malThemeParser';
import { mergeThemeSongs } from '../themeSongs/mergeThemeSongs';
import type { AniplaylistHit } from '../themeSongs/aniplaylistApi';

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
});
