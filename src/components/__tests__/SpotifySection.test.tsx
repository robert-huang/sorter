import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { _clearSpotifyApiBanForTesting } from '../../lib/spotify/spotifyApi';
import { _clearSpotifyAuthForTesting } from '../../lib/spotify/spotifyAuth';
import { _clearSpotifyLocalFileMatchPreferencesForTesting } from '../../lib/spotify/spotifyLocalFileMatchPreferences';
import { _clearSpotifyPlaylistForTesting } from '../../lib/spotify/spotifyPlaylist';
import { SpotifySection } from '../SpotifySection';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  _clearSpotifyApiBanForTesting();
  _clearSpotifyAuthForTesting();
  _clearSpotifyPlaylistForTesting();
  _clearSpotifyLocalFileMatchPreferencesForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
});
