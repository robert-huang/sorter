import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSpotifyApiBanForTesting } from '../../lib/spotify/spotifyApi';
import {
  SPOTIFY_AUTH_STORAGE_KEY,
  _clearSpotifyAuthForTesting,
} from '../../lib/spotify/spotifyAuth';
import { _clearSpotifyLocalFileMatchPreferencesForTesting } from '../../lib/spotify/spotifyLocalFileMatchPreferences';
import {
  PLAYLIST_STORAGE_KEY,
  _clearSpotifyPlaylistForTesting,
  _resetSpotifyPlaylistCacheMemoryForTesting,
  setSelectedSpotifyPlaylist,
} from '../../lib/spotify/spotifyPlaylist';
import {
  _setSpotifyPlaylistCachePersistenceForTesting,
  _setSpotifyTrackIsrcPersistenceForTesting,
} from '../../lib/spotify/spotifyPlaylistCacheDb';
import {
  createPlaylistCachePersistence,
  createTrackIsrcPersistence,
} from '../../lib/spotify/__tests__/spotifyCachePersistenceTestUtils';
import { _clearTrackIsrcStoreForTesting } from '../../lib/spotify/spotifyTrackIsrcStore';
import { SpotifySection } from '../SpotifySection';

let container: HTMLDivElement;
let root: Root;
let playlistPersistence: ReturnType<typeof createPlaylistCachePersistence>;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  playlistPersistence = createPlaylistCachePersistence();
  _setSpotifyPlaylistCachePersistenceForTesting(playlistPersistence);
  _setSpotifyTrackIsrcPersistenceForTesting(createTrackIsrcPersistence());
  _clearSpotifyApiBanForTesting();
  _clearSpotifyAuthForTesting();
  await Promise.all([
    _clearSpotifyPlaylistForTesting(),
    _clearTrackIsrcStoreForTesting(),
  ]);
  _clearSpotifyLocalFileMatchPreferencesForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await Promise.all([
    _clearSpotifyPlaylistForTesting(),
    _clearTrackIsrcStoreForTesting(),
  ]);
  _setSpotifyPlaylistCachePersistenceForTesting(null);
  _setSpotifyTrackIsrcPersistenceForTesting(null);
  vi.restoreAllMocks();
});

describe('SpotifySection local-file matching control', () => {
  it('renders Off by default and persists a changed mode', async () => {
    await act(async () => {
      root.render(<SpotifySection />);
    });

    const group = container.querySelector('[aria-label="Match local files"]');
    const buttons = [...(group?.querySelectorAll('button') ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Off',
      'Local',
      'Spotify',
    ]);
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual([
      'Exact playlist matches are green; Spotify songs missing from the playlist are red.',
      'Priority: exact match (green), then title/artist match (blue), then missing Spotify song (red).',
      'Priority: exact match (green), then missing Spotify song (red). Blue is only used for songs without a Spotify track.',
    ]);
    expect(container.textContent).toContain('Song titles');
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      buttons[1]?.click();
    });

    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('spotify:local-file-match:v1')).toBe('local-first');
  });

  it('right-click clears all playlist caches, preserves selection, and refreshes it', async () => {
    playlistPersistence = createPlaylistCachePersistence([
      {
        playlistId: 'selected-playlist',
        fetchedAt: 1,
        tracks: [{ id: 'old-track', isrc: null, linkedFromIds: [] }],
      },
      {
        playlistId: 'other-playlist',
        fetchedAt: 2,
        tracks: [{ id: 'other-track', isrc: null, linkedFromIds: [] }],
      },
    ]);
    _setSpotifyPlaylistCachePersistenceForTesting(playlistPersistence);
    _resetSpotifyPlaylistCacheMemoryForTesting();

    localStorage.setItem(
      SPOTIFY_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'token',
        refreshToken: '',
        expiresAt: Date.now() + 120_000,
        displayName: 'Test User',
        spotifyUserId: 'user-1',
      }),
    );
    setSelectedSpotifyPlaylist({
      id: 'selected-playlist',
      name: 'Anime Themes',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/me/playlists')) {
        return new Response(
          JSON.stringify({ items: [], next: null }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ items: [], total: 0 }),
        { status: 200 },
      );
    });

    await act(async () => {
      root.render(<SpotifySection />);
      await Promise.resolve();
    });

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh playlist cache"]',
    );
    expect(refreshButton?.title).toBe(
      'Refresh this playlist. Right-click to clear all cached playlists, then refresh this playlist.',
    );
    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      refreshButton?.dispatchEvent(contextMenu);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(playlistPersistence.snapshot().map((cache) => cache.playlistId)).toEqual([
      'selected-playlist',
    ]);
    expect(localStorage.getItem(PLAYLIST_STORAGE_KEY)).toContain(
      'selected-playlist',
    );
  });
});
