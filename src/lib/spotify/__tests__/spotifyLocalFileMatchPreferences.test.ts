import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearSpotifyLocalFileMatchPreferencesForTesting,
  loadSpotifyLocalFileMatchMode,
  saveSpotifyLocalFileMatchMode,
  subscribeSpotifyLocalFileMatchMode,
} from '../spotifyLocalFileMatchPreferences';

describe('Spotify local-file match preferences', () => {
  beforeEach(() => {
    _clearSpotifyLocalFileMatchPreferencesForTesting();
  });

  it('defaults to Off', () => {
    expect(loadSpotifyLocalFileMatchMode()).toBe('off');
  });

  it.each(['off', 'local-first', 'spotify-first'] as const)(
    'persists %s mode',
    (mode) => {
      saveSpotifyLocalFileMatchMode(mode);

      expect(localStorage.getItem('spotify:local-file-match:v1')).toBe(mode);
      expect(loadSpotifyLocalFileMatchMode()).toBe(mode);
    },
  );

  it('falls back to Off for an unsupported stored value', () => {
    localStorage.setItem('spotify:local-file-match:v1', 'unexpected');

    expect(loadSpotifyLocalFileMatchMode()).toBe('off');
  });

  it('notifies active consumers when the mode changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpotifyLocalFileMatchMode(listener);

    saveSpotifyLocalFileMatchMode('local-first');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    saveSpotifyLocalFileMatchMode('spotify-first');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
