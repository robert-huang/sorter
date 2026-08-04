import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlaylistMatchResult } from '../../lib/spotify/spotifyPlaylistMatch';
import { ThemeSongPlaylistDot } from '../themeSongRowC';

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

async function renderDot(match: PlaylistMatchResult): Promise<void> {
  await act(async () => {
    root.render(<ThemeSongPlaylistDot match={match} />);
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
