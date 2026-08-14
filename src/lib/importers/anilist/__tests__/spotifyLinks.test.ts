import { describe, expect, it } from 'vitest';
import {
  buildSpotifySearchUrl,
  collectSpotifyTrackIds,
  encodeSpotifySearchPathSegment,
  isSpotifyUnavailableInMarket,
  mergeSpotifyTrackIdSources,
  normalizeSpotifyUrl,
  parseSpotifyTrackIdFromUrl,
  pickSpotifyLink,
  pickSpotifyLinkDetails,
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

  it('recognizes the current AniPlaylist JP-only duplicate shape', () => {
    const picked = pickSpotifyLinkDetails([
      {
        platform: 'spotify',
        main: true,
        link: 'https://open.spotify.com/track/17Nkp414niqEx1XmfB0Q1k',
        link_markets: ['CA', 'JP', 'US'],
      },
      {
        platform: 'spotify',
        link: 'https://open.spotify.com/track/6V4ySJsF3NvRfr0XymF8NQ',
        link_markets: ['JP'],
      },
    ]);

    expect(picked).toEqual({
      url: 'https://open.spotify.com/track/6V4ySJsF3NvRfr0XymF8NQ',
      availableMarkets: ['JP'],
    });
  });

  it('checks selected-link availability against the Spotify account market', () => {
    expect(isSpotifyUnavailableInMarket(['JP'], 'CA')).toBe(true);
    expect(isSpotifyUnavailableInMarket(['CA', 'JP'], 'CA')).toBe(false);
    expect(isSpotifyUnavailableInMarket(undefined, 'CA')).toBe(false);
  });

  it('strips attribution metadata from selected spotify links', () => {
    const url = pickSpotifyLink([
      {
        platform: 'spotify',
        main: true,
        link:
          'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?utm_source=aniplaylist&utm_medium=website',
      },
    ]);

    expect(url).toBe('https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN');
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
    expect(normalizeSpotifyUrl(legacy)).toBe(
      'https://open.spotify.com/search/Hawatari%20Nioku%20Centi%20MAXIMUM%20THE%20HORMONE',
    );
  });

  it('strips known spotify share metadata while preserving link behavior', () => {
    expect(
      normalizeSpotifyUrl(
        'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?si=share-id&dlsi=deep-link-id&sp_cid=session-id&utm_campaign=spring&nd=1&go=1#lyrics',
      ),
    ).toBe(
      'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?nd=1&go=1#lyrics',
    );
  });

  it('does not alter non-spotify urls', () => {
    const url = 'https://example.com/track/id?utm_source=example';

    expect(normalizeSpotifyUrl(url)).toBe(url);
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

  it('mergeSpotifyTrackIdSources adds id from display url', () => {
    expect(
      mergeSpotifyTrackIdSources(
        [],
        'https://open.spotify.com/track/6gYV0M8HLVwW6tKQfzv7Jk?utm_source=aniplaylist',
      ),
    ).toEqual(['6gYV0M8HLVwW6tKQfzv7Jk']);
  });
});
