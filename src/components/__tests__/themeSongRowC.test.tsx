import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MediaThemeSongRow } from '../../lib/importers/anilist/themeSongs/types';
import type { PlaylistMatchResult } from '../../lib/spotify/spotifyPlaylistMatch';
import { ThemeSongPlaylistDot, ThemeSongRowC } from '../themeSongRowC';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderDot(
  match: PlaylistMatchResult,
  marketUnavailable = false,
  spotifyCountry?: string,
): Promise<void> {
  await act(async () => {
    root.render(
      <ThemeSongPlaylistDot
        match={match}
        marketUnavailable={marketUnavailable}
        spotifyCountry={spotifyCountry}
      />,
    );
  });
}

describe('ThemeSongPlaylistDot', () => {
  it('uses an informational local-match dot with playlist metadata in its tooltip', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: {
        kind: 'local',
        track: {
          title: 'Houkiboshi (TV Size)',
          artists: ['Younha', 'ユンナ'],
          album: 'Bleach',
          durationMs: 89_000,
          playlistPosition: 17,
        },
      },
    });

    const dot = container.querySelector('.anilist-detail-theme-song-playlist-dot');
    expect(dot?.classList.contains('is-metadata')).toBe(true);
    expect(dot?.classList.contains('is-in')).toBe(false);
    expect(dot?.getAttribute('title')).toBe(
      'Matched playlist local file: \n\n#17 · Houkiboshi (TV Size) — Younha, ユンナ',
    );
    expect(dot?.getAttribute('aria-label')).toBe(dot?.getAttribute('title'));
  });

  it('identifies a catalog title/artist match in the blue-dot tooltip', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: {
        kind: 'spotify',
        track: {
          title: 'ウンディーネ',
          artists: ['Yui Makino'],
          album: 'ウンディーネ',
          durationMs: 345_426,
          playlistPosition: 1,
        },
      },
    });

    expect(container.querySelector('.is-metadata')?.getAttribute('title')).toBe(
      'Matched Spotify playlist track by title/artist: \n\n#1 · ウンディーネ — Yui Makino',
    );
  });

  it('shows the playlist position for exact matches', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: null,
      playlistPosition: 3488,
    });
    expect(container.querySelector('.is-in')?.getAttribute('title')).toBe(
      'In your Spotify playlist at #3488',
    );
  });

  it('uses an orange dot for unavailable playlist matches', async () => {
    await renderDot(
      {
        status: 'in',
        metadataMatch: {
          kind: 'spotify',
          track: {
            title: 'Unavailable song',
            artists: ['Artist'],
            album: 'Album',
            durationMs: 180_000,
            playlistPosition: 17,
          },
        },
      },
      true,
      'CA',
    );

    const dot = container.querySelector('.is-market-unavailable');
    expect(dot?.getAttribute('title')).toBe(
      'In your Spotify playlist at #17, but unavailable in your market (CA)',
    );
    expect(container.querySelector('.is-metadata')).toBeNull();
    expect(container.querySelector('.is-in')).toBeNull();
  });

  it('preserves exact in/out indicators and leaves unknown rows without a dot', async () => {
    await renderDot({ status: 'in', metadataMatch: null });
    expect(container.querySelector('.is-in')?.getAttribute('title')).toBe(
      'In your Spotify playlist',
    );
    await renderDot({ status: 'out', metadataMatch: null });
    expect(container.querySelector('.is-out')?.getAttribute('title')).toBe(
      'Not in your Spotify playlist',
    );

    await renderDot({ status: 'unknown', metadataMatch: null });
    expect(container.querySelector('.anilist-detail-theme-song-playlist-dot')).toBeNull();
  });
});

describe('ThemeSongRowC', () => {
  it('uses a canonical spotify URL for existing cached theme songs', async () => {
    const row: MediaThemeSongRow = {
      type: 'Opening',
      sortOrder: 1,
      displayTitle: 'Track title',
      displayArtist: 'Artist',
      spotifyUrl:
        'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?utm_source=aniplaylist&utm_medium=website',
      spotifyTrackIds: ['3EXRwq9SPcToT8MfPAgRxN'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };

    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={row}
          playlistMatch={{ status: 'unknown', metadataMatch: null }}
          showPlaylistMatch={false}
        />,
      );
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN',
    );
  });

  it('shows an orange dot when the selected link is unavailable in the account market', async () => {
    const row: MediaThemeSongRow = {
      type: 'Ending',
      sortOrder: 0,
      displayTitle: 'からっぽカプセル',
      displayArtist: 'Maaya Uchida',
      spotifyUrl: 'https://open.spotify.com/track/6V4ySJsF3NvRfr0XymF8NQ',
      spotifyAvailableMarkets: ['JP'],
      spotifyTrackIds: ['6V4ySJsF3NvRfr0XymF8NQ'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };

    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={row}
          playlistMatch={{ status: 'out', metadataMatch: null }}
          showPlaylistMatch={false}
          spotifyCountry="CA"
        />,
      );
    });

    expect(container.querySelector('.is-market-unavailable')?.getAttribute('title')).toBe(
      'On Spotify, but unavailable in your market (CA)',
    );
    expect(container.querySelector('.is-out')).toBeNull();
  });
});
