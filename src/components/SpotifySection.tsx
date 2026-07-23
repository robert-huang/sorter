import { useCallback, useEffect, useState } from 'react';
import {
  getStoredSpotifyAuth,
  getSpotifyOAuthCallbackUrl,
  isSpotifyOAuthConfigured,
  signInToSpotify,
  signOutSpotify,
  subscribeSpotifyAuth,
} from '../lib/spotify/spotifyAuth';
import {
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  isPlaylistCacheStale,
  listUserSpotifyPlaylists,
  refreshPlaylistCache,
  setSelectedSpotifyPlaylist,
  subscribeSpotifyPlaylist,
  type StoredSpotifyPlaylist,
} from '../lib/spotify/spotifyPlaylist';

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
  const [auth, setAuth] = useState(() => getStoredSpotifyAuth());
  const [selectedPlaylist, setSelectedPlaylist] = useState(() => getSelectedSpotifyPlaylist());
  const [playlists, setPlaylists] = useState<StoredSpotifyPlaylist[]>([]);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [refreshingCache, setRefreshingCache] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = isSpotifyOAuthConfigured();
  const callbackUrl = getSpotifyOAuthCallbackUrl();
  const cache = getPlaylistCache();
  void cacheRevision;
  const showDevSetup = import.meta.env.DEV && configured;

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

  const loadPlaylists = useCallback(async () => {
    setLoadingPlaylists(true);
    setError(null);
    try {
      const items = await listUserSpotifyPlaylists();
      setPlaylists(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Spotify playlists');
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
    const match = playlists.find((p) => p.id === playlistId);
    if (!match) {
      return;
    }
    setSelectedSpotifyPlaylist(match);
    setError(null);
  }, [playlists]);

  const onRefreshCache = useCallback(async () => {
    if (!selectedPlaylist) {
      return;
    }
    setRefreshingCache(true);
    setError(null);
    try {
      await refreshPlaylistCache({ force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh playlist cache');
    } finally {
      setRefreshingCache(false);
    }
  }, [selectedPlaylist]);

  return (
    <div className="settings-spotify-section">
      <div className="settings-status settings-section-label">Spotify (theme songs)</div>
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
          <div className="settings-status">
            {auth.displayName ? `Signed in as ${auth.displayName}` : 'Signed in to Spotify'}
          </div>
          <button type="button" className="settings-item" onClick={onSignOut}>
            Sign out of Spotify
          </button>
          <div className="settings-status settings-section-label" style={{ marginTop: 8 }}>
            Anime themes playlist
          </div>
          {loadingPlaylists ? (
            <div className="settings-status settings-anilist-hint">Loading playlists…</div>
          ) : (
            <label className="settings-item" style={{ display: 'block' }}>
              <span className="settings-item-hint" style={{ display: 'block', marginBottom: 4 }}>
                Pick a playlist you own (or collaborate on) to match against theme songs in detail
                modals.
              </span>
              <select
                value={selectedPlaylist?.id ?? ''}
                onChange={(e) => onSelectPlaylist(e.target.value)}
                style={{ width: '100%', maxWidth: 320 }}
              >
                <option value="">— select playlist —</option>
                {playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedPlaylist && (
            <>
              <button
                type="button"
                className="settings-item"
                disabled={refreshingCache}
                onClick={() => void onRefreshCache()}
              >
                {refreshingCache ? 'Refreshing playlist…' : '↻ Refresh playlist cache'}
              </button>
              {cache && cache.playlistId === selectedPlaylist.id ? (
                <div className="settings-status settings-anilist-hint">
                  {cache.tracks.length} tracks cached · {formatFetchedAt(cache.fetchedAt)}
                  {isPlaylistCacheStale(cache.fetchedAt) ? ' · stale (refresh recommended)' : ''}
                </div>
              ) : (
                <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
                  No cache yet — refresh to load tracks for matching.
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <div className="settings-source-db-error" role="alert">
          {error}
        </div>
      )}
      <div className="settings-divider" />
    </div>
  );
}
