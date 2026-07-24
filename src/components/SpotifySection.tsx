import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsAccountRow } from './SettingsAccountRow';
import {
  getStoredSpotifyAuth,
  getSpotifyOAuthCallbackUrl,
  isSpotifyOAuthConfigured,
  signInToSpotify,
  signOutSpotify,
  subscribeSpotifyAuth,
} from '../lib/spotify/spotifyAuth';
import { useSpotifyApiBannedUntil } from '../hooks/useSpotifyApiBannedUntil';
import { useThemeSongDisplayPreferences } from '../hooks/useThemeSongDisplayPreferences';
import {
  clearSelectedSpotifyPlaylist,
  formatSpotifyApiBanMessage,
  getActivePlaylistCache,
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  isPlaylistCacheStale,
  listUserSpotifyPlaylists,
  mergeSelectedPlaylistIntoOptions,
  refreshPlaylistCache,
  setSelectedSpotifyPlaylist,
  SpotifyApiRateLimitedError,
  subscribeSpotifyPlaylist,
  type StoredSpotifyPlaylist,
} from '../lib/spotify/spotifyPlaylist';
import {
  getPlaylistIsrcBackfillState,
  subscribePlaylistIsrcBackfill,
} from '../lib/spotify/spotifyPlaylistIsrcBackfill';
import type { ThemeSongNameDisplayMode } from '../lib/spotify/themeSongDisplayPreferences';

const THEME_SONG_NAME_OPTIONS: { value: ThemeSongNameDisplayMode; label: string }[] = [
  { value: 'english', label: 'English' },
  { value: 'native', label: 'Native' },
];

function formatFetchedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'unknown';
  }
}

/**
 * Spotify sign-in + anime-theme playlist picker for the gear menu.
 * Playlist cache is manual-refresh only (15m stale hint).
 */
export function SpotifySection() {
  const { mode: themeSongNameMode, setMode: setThemeSongNameMode } =
    useThemeSongDisplayPreferences();
  const [auth, setAuth] = useState(() => getStoredSpotifyAuth());
  const [selectedPlaylist, setSelectedPlaylist] = useState(() => getSelectedSpotifyPlaylist());
  const [playlists, setPlaylists] = useState<StoredSpotifyPlaylist[]>([]);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [refreshingCache, setRefreshingCache] = useState(false);
  const [isrcBackfill, setIsrcBackfill] = useState(() => getPlaylistIsrcBackfillState());
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = isSpotifyOAuthConfigured();
  const callbackUrl = getSpotifyOAuthCallbackUrl();
  const cache = getPlaylistCache();
  const activeCache = getActivePlaylistCache();
  const spotifyBannedUntil = useSpotifyApiBannedUntil();
  const spotifyBanMessage = spotifyBannedUntil
    ? formatSpotifyApiBanMessage(spotifyBannedUntil)
    : null;
  const playlistOptions = useMemo(
    () => mergeSelectedPlaylistIntoOptions(playlists, selectedPlaylist),
    [playlists, selectedPlaylist],
  );
  void cacheRevision;
  const showDevSetup = import.meta.env.DEV && configured;

  useEffect(() => {
    if (!spotifyBannedUntil) {
      return;
    }
    setError((current) =>
      current?.startsWith('Spotify API rate limited') ||
      current?.startsWith('Spotify API quota exceeded')
        ? null
        : current,
    );
  }, [spotifyBannedUntil]);

  useEffect(() => {
    return subscribeSpotifyAuth(() => {
      setAuth(getStoredSpotifyAuth());
    });
  }, []);

  useEffect(() => {
    return subscribeSpotifyPlaylist(() => {
      setSelectedPlaylist(getSelectedSpotifyPlaylist());
      setCacheRevision((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    return subscribePlaylistIsrcBackfill(() => {
      setIsrcBackfill(getPlaylistIsrcBackfillState());
      setCacheRevision((n) => n + 1);
    });
  }, []);

  const loadPlaylists = useCallback(async () => {
    setLoadingPlaylists(true);
    setError(null);
    try {
      const items = await listUserSpotifyPlaylists();
      setPlaylists(items);
    } catch (err) {
      if (err instanceof SpotifyApiRateLimitedError) {
        setError(formatSpotifyApiBanMessage(err.bannedUntil));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load Spotify playlists');
      }
    } finally {
      setLoadingPlaylists(false);
    }
  }, []);

  useEffect(() => {
    if (auth && playlists.length === 0) {
      void loadPlaylists();
    }
  }, [auth, playlists.length, loadPlaylists]);

  const onSignIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      await signInToSpotify();
      await loadPlaylists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spotify sign-in failed');
    } finally {
      setSigningIn(false);
    }
  }, [loadPlaylists]);

  const onSignOut = useCallback(() => {
    signOutSpotify();
    setPlaylists([]);
  }, []);

  const onSelectPlaylist = useCallback((playlistId: string) => {
    if (!playlistId) {
      clearSelectedSpotifyPlaylist();
      setError(null);
      return;
    }
    const match = playlistOptions.find((p) => p.id === playlistId);
    if (!match) {
      return;
    }
    setSelectedSpotifyPlaylist(match);
    setError(null);
  }, [playlistOptions]);

  const onRefreshCache = useCallback(async () => {
    if (!selectedPlaylist) {
      return;
    }
    setRefreshingCache(true);
    setError(null);
    try {
      await refreshPlaylistCache({ force: true });
    } catch (err) {
      if (err instanceof SpotifyApiRateLimitedError) {
        setError(formatSpotifyApiBanMessage(err.bannedUntil));
      } else {
        setError(err instanceof Error ? err.message : 'Failed to refresh playlist cache');
      }
    } finally {
      setRefreshingCache(false);
    }
  }, [selectedPlaylist]);

  return (
    <div className="settings-spotify-section">
      <div className="settings-status settings-section-label">Spotify (theme songs)</div>
      <div className="settings-anilist-display-prefs settings-spotify-theme-names">
        <div className="filter-chip-range-row">
          <span>title</span>
          <div className="filter-chip-segmented" role="group" aria-label="Theme song title">
            {THEME_SONG_NAME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={themeSongNameMode === option.value ? 'active' : ''}
                aria-pressed={themeSongNameMode === option.value}
                onClick={() => setThemeSongNameMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!configured && (
        <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
          Spotify sign-in is not configured for this build (
          <code>VITE_SPOTIFY_CLIENT_ID</code> / <code>VITE_SPOTIFY_CLIENT_SECRET</code>).
        </div>
      )}
      {showDevSetup && (
        <div className="settings-status settings-anilist-hint">
          Dev setup: register redirect URL <code>{callbackUrl}</code> on your Spotify app.
        </div>
      )}
      {!auth ? (
        <>
          <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
            Sign in to compare theme songs against a Spotify playlist (green = in playlist).
          </div>
          {configured && (
            <button
              type="button"
              className="settings-item"
              disabled={signingIn}
              onClick={() => void onSignIn()}
            >
              {signingIn ? 'Waiting for Spotify…' : 'Sign in to Spotify…'}
            </button>
          )}
        </>
      ) : (
        <>
          <SettingsAccountRow onSignOut={onSignOut} signOutLabel="Sign out of Spotify">
            <span>
              {auth.displayName ? `Signed in as ${auth.displayName}` : 'Signed in to Spotify'}
            </span>
          </SettingsAccountRow>
          <div className="settings-status settings-section-label">Anime themes playlist</div>
          {loadingPlaylists ? (
            <div className="settings-status settings-anilist-hint">Loading playlists…</div>
          ) : (
            <div className="settings-spotify-playlist-row">
              <select
                className="settings-spotify-select settings-spotify-select-compact"
                value={selectedPlaylist?.id ?? ''}
                onChange={(e) => onSelectPlaylist(e.target.value)}
                aria-label="Anime themes playlist"
              >
                <option value="">— select playlist —</option>
                {playlistOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedPlaylist && (
                <button
                  type="button"
                  className="btn small icon-only"
                  disabled={refreshingCache || spotifyBannedUntil !== null}
                  onClick={() => void onRefreshCache()}
                  title={
                    spotifyBannedUntil !== null
                      ? 'Spotify API rate limited'
                      : 'Refresh playlist cache'
                  }
                  aria-label="Refresh playlist cache"
                >
                  {refreshingCache ? '…' : '↻'}
                </button>
              )}
            </div>
          )}
          {spotifyBanMessage ? (
            <div className="settings-status settings-anilist-hint settings-cache-stale" role="status">
              {spotifyBanMessage}
            </div>
          ) : null}
          {selectedPlaylist &&
            (activeCache ? (
              <div className="settings-status settings-anilist-hint">
                {activeCache.tracks.length} tracks cached · {formatFetchedAt(activeCache.fetchedAt)}
                {isPlaylistCacheStale(activeCache.fetchedAt) ? (
                  <span className="settings-cache-stale"> · stale (&gt;15m)</span>
                ) : null}
                {isrcBackfill.status === 'running' &&
                isrcBackfill.playlistId === selectedPlaylist.id ? (
                  <span>
                    {' '}
                    · ISRC backfill {isrcBackfill.completed}/{isrcBackfill.total}
                  </span>
                ) : null}
                {isrcBackfill.status === 'paused' &&
                isrcBackfill.playlistId === selectedPlaylist.id ? (
                  <span className="settings-cache-stale"> · ISRC backfill paused (rate limit)</span>
                ) : null}
              </div>
            ) : cache && cache.playlistId === selectedPlaylist.id ? (
              <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
                Playlist list unavailable — cached tracks still used for matching.
              </div>
            ) : (
              <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
                No cache yet — refresh to load tracks for matching.
              </div>
            ))}
        </>
      )}
      {error && !spotifyBanMessage && (
        <div className="settings-source-db-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
