import { describe, expect, it } from 'vitest';
import {
  collectSpotifyTrackIds,
  parseSpotifyTrackIdFromUrl,
  pickSpotifyLink,
} from '../themeSongs/spotifyLinks';

describe('spotifyLinks', () => {
  it('parses track id from spotify url', () => {
    expect(
      parseSpotifyTrackIdFromUrl(
        'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?utm_source=aniplaylist',
      ),
    ).toBe('3EXRwq9SPcToT8MfPAgRxN');
  });

  it('prefers Japan link over main spotify link', () => {
    const url = pickSpotifyLink([
      {
        platform: 'spotify',
        main: true,
        link: 'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN',
      },
      {
        platform: 'spotify',
        detail: 'Japan link',
        link: 'https://open.spotify.com/track/63ZUSqv3yd19ko7ChvzgAj',
      },
    ]);
    expect(url).toContain('63ZUSqv3yd19ko7ChvzgAj');
  });

  it('collects track ids from links and other_link_ids', () => {
    const ids = collectSpotifyTrackIds(
      [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN',
        },
      ],
      ['63ZUSqv3yd19ko7ChvzgAj', '1887446344'],
      'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN',
    );
    expect(ids).toContain('3EXRwq9SPcToT8MfPAgRxN');
    expect(ids).toContain('63ZUSqv3yd19ko7ChvzgAj');
    expect(ids).not.toContain('1887446344');
  });
});
