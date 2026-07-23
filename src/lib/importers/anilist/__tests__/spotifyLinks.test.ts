import { describe, expect, it } from 'vitest';
import {
  buildSpotifySearchUrl,
  collectSpotifyTrackIds,
  encodeSpotifySearchPathSegment,
  normalizeSpotifySearchUrl,
  parseSpotifyTrackIdFromUrl,
  pickSpotifyLink,
  sanitizeSpotifySearchQuery,
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

  it('encodes parentheses in spotify search path segments', () => {
    expect(encodeSpotifySearchPathSegment('foo (bar)')).toBe('foo%20%28bar%29');
  });

  it('strips parenthetical edit tags from search queries', () => {
    expect(
      sanitizeSpotifySearchQuery(
        'Hawatari Nioku Centi (Zentai Suitei 70% Kaikin edit)',
        'MAXIMUM THE HORMONE',
      ),
    ).toBe('Hawatari Nioku Centi MAXIMUM THE HORMONE');
  });

  it('builds spotify search urls without raw parentheses', () => {
    expect(
      buildSpotifySearchUrl(
        'Hawatari Nioku Centi (Zentai Suitei 70% Kaikin edit)',
        'MAXIMUM THE HORMONE',
      ),
    ).toBe(
      'https://open.spotify.com/search/Hawatari%20Nioku%20Centi%20MAXIMUM%20THE%20HORMONE',
    );
  });

  it('normalizes legacy spotify search urls with raw parentheses', () => {
    const legacy =
      'https://open.spotify.com/search/Hawatari%20Nioku%20Centi%20(Zentai%20Suitei%2070%25%20Kaikin%20edit)%20MAXIMUM%20THE%20HORMONE';
    expect(normalizeSpotifySearchUrl(legacy)).toBe(
      'https://open.spotify.com/search/Hawatari%20Nioku%20Centi%20MAXIMUM%20THE%20HORMONE',
    );
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
