/**
 * Playlist writes (add, remove, create). Edits update the cached playlist in
 * place instead of refetching; positions can drift from Spotify if the
 * playlist changed elsewhere, and the next refetch corrects them.
 */
import { ensureSpotifyAccessToken } from './spotifyAuth';
import {
  countCachedPlaylistTracks,
  editPlaylistCache,
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  sendSpotifyJson,
  type CachedPlaylistTrack,
  type SpotifyPlaylistCache,
} from './spotifyPlaylist';

/** Spotify accepts at most this many URIs per add/remove request. */
export const SPOTIFY_PLAYLIST_EDIT_BATCH_SIZE = 100;

export type NewPlaylistTrack = {
  id: string;
  title: string;
  artists: string[];
  isrc: string | null;
};

/** Ids and ISRCs identifying one theme song on the playlist. */
export type PlaylistTrackIdentity = {
  trackIds: readonly string[];
  isrcs: readonly string[];
};

const SPOTIFY_API = 'https://api.spotify.com/v1';

function playlistItemsUrl(playlistId: string): string {
  return `${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/items`;
}

function trackUri(trackId: string): string {
  return `spotify:track:${trackId}`;
}

function storedPlaylistLength(cache: SpotifyPlaylistCache): number {
  return cache.trackTotal ?? countCachedPlaylistTracks(cache);
}

function shiftPosition<T extends { playlistPosition: number }>(item: T, delta: number): T {
  return { ...item, playlistPosition: item.playlistPosition + delta };
}

function shiftTrack(
  track: CachedPlaylistTrack,
  shift: (position: number) => number,
): CachedPlaylistTrack {
  if (!track.metadata) {
    return track;
  }
  const next = shift(track.metadata.playlistPosition);
  return next === track.metadata.playlistPosition
    ? track
    : { ...track, metadata: shiftPosition(track.metadata, next - track.metadata.playlistPosition) };
}

/**
 * Cache after inserting `added` after 1-based `afterPosition`, or at the end.
 * e.g. tracks #1..#5, anchor #3, two added: new #4 and #5, old #4 and #5 become #6 and #7.
 */
export function insertTracksIntoPlaylistCache(
  cache: SpotifyPlaylistCache,
  added: readonly NewPlaylistTrack[],
  afterPosition?: number,
): SpotifyPlaylistCache {
  const length = storedPlaylistLength(cache);
  const anchor = afterPosition == null ? length : Math.min(Math.max(afterPosition, 0), length);
  const shift = (position: number): number =>
    position > anchor ? position + added.length : position;
  const newTracks: CachedPlaylistTrack[] = added.map((track, index) => ({
    id: track.id,
    isrc: track.isrc,
    linkedFromIds: [],
    metadata: {
      title: track.title,
      artists: track.artists,
      album: null,
      durationMs: null,
      playlistPosition: anchor + index + 1,
    },
  }));
  return {
    ...cache,
    tracks: [...cache.tracks.map((track) => shiftTrack(track, shift)), ...newTracks],
    ...(cache.localTracks
      ? {
          localTracks: cache.localTracks.map((local) =>
            local.playlistPosition > anchor ? shiftPosition(local, added.length) : local,
          ),
        }
      : {}),
    trackTotal: length + added.length,
  };
}

function trackMatchesIdentity(
  track: CachedPlaylistTrack,
  identity: PlaylistTrackIdentity,
): boolean {
  if (identity.trackIds.includes(track.id)) {
    return true;
  }
  if (track.linkedFromIds.some((id) => identity.trackIds.includes(id))) {
    return true;
  }
  const isrc = track.isrc?.toUpperCase();
  return isrc != null && identity.isrcs.some((candidate) => candidate.toUpperCase() === isrc);
}

/** URI Spotify stores for a playlist item (the pre-relinking id when relinked). */
function playlistItemUri(track: CachedPlaylistTrack): string {
  return trackUri(track.linkedFromIds[0] ?? track.id);
}

/** Cached tracks that the identity matches, i.e. what a remove would delete. */
export function findPlaylistTracksForIdentity(
  cache: SpotifyPlaylistCache,
  identity: PlaylistTrackIdentity,
): CachedPlaylistTrack[] {
  return cache.tracks.filter((track) => trackMatchesIdentity(track, identity));
}

/** Cache after removing every copy of the given item URIs, shifting later items up. */
export function removeTracksFromPlaylistCache(
  cache: SpotifyPlaylistCache,
  uris: ReadonlySet<string>,
): SpotifyPlaylistCache {
  const removed = cache.tracks.filter((track) => uris.has(playlistItemUri(track)));
  if (removed.length === 0) {
    return cache;
  }
  const removedPositions = removed
    .map((track) => track.metadata?.playlistPosition)
    .filter((position): position is number => position != null);
  const shift = (position: number): number =>
    position - removedPositions.filter((removedPosition) => removedPosition < position).length;
  return {
    ...cache,
    tracks: cache.tracks
      .filter((track) => !uris.has(playlistItemUri(track)))
      .map((track) => shiftTrack(track, shift)),
    ...(cache.localTracks
      ? {
          localTracks: cache.localTracks.map((local) => {
            const next = shift(local.playlistPosition);
            return next === local.playlistPosition
              ? local
              : shiftPosition(local, next - local.playlistPosition);
          }),
        }
      : {}),
    trackTotal: Math.max(0, storedPlaylistLength(cache) - removed.length),
  };
}

async function requireToken(): Promise<string> {
  const token = await ensureSpotifyAccessToken();
  if (!token) {
    throw new Error('Sign in to Spotify to edit playlists.');
  }
  return token;
}

function requireSelectedPlaylistId(): string {
  const selected = getSelectedSpotifyPlaylist();
  if (!selected) {
    throw new Error('Select a Spotify playlist first.');
  }
  return selected.id;
}

/** Add tracks after 1-based `afterPosition` (or at the end) of the selected playlist. */
export async function insertTracksIntoSelectedPlaylist(
  tracks: readonly NewPlaylistTrack[],
  options?: { afterPosition?: number },
): Promise<void> {
  if (tracks.length === 0) {
    return;
  }
  const playlistId = requireSelectedPlaylistId();
  const token = await requireToken();
  const cache = getPlaylistCache(playlistId);
  const anchor =
    options?.afterPosition != null && cache
      ? Math.min(options.afterPosition, storedPlaylistLength(cache))
      : options?.afterPosition;
  // A 1-based anchor is the 0-based index right after it.
  await sendSpotifyJson(playlistItemsUrl(playlistId), token, 'POST', {
    uris: tracks.map((track) => trackUri(track.id)),
    ...(anchor != null ? { position: anchor } : {}),
  });
  await editPlaylistCache(playlistId, (current) =>
    insertTracksIntoPlaylistCache(current, tracks, anchor),
  );
}

/** Remove every playlist copy of the song; resolves to the number of copies removed. */
export async function removeTrackFromSelectedPlaylist(
  identity: PlaylistTrackIdentity,
): Promise<number> {
  const playlistId = requireSelectedPlaylistId();
  const cache = getPlaylistCache(playlistId);
  const matches = cache ? findPlaylistTracksForIdentity(cache, identity) : [];
  if (matches.length === 0) {
    throw new Error('This song is not on the cached playlist. Refresh the playlist and try again.');
  }
  const uris = new Set(matches.map(playlistItemUri));
  const token = await requireToken();
  await sendSpotifyJson(playlistItemsUrl(playlistId), token, 'DELETE', {
    items: [...uris].map((uri) => ({ uri })),
  });
  await editPlaylistCache(playlistId, (current) => removeTracksFromPlaylistCache(current, uris));
  return matches.length;
}

export type CreatePlaylistProgress = { added: number; total: number };

/** Thrown when creation succeeded but adding songs stopped partway. */
export class SpotifyPlaylistPartialCreateError extends Error {
  readonly added: number;
  readonly total: number;
  constructor(name: string, added: number, total: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : 'request failed';
    super(`Created "${name}" but only added ${added} of ${total} songs: ${reason}`);
    this.name = 'SpotifyPlaylistPartialCreateError';
    this.added = added;
    this.total = total;
  }
}

/** Create a playlist for the signed-in user and add `trackIds` in order. Doesn't select it. */
export async function createSpotifyPlaylistWithTracks(options: {
  name: string;
  isPublic: boolean;
  trackIds: readonly string[];
  onProgress?: (progress: CreatePlaylistProgress) => void;
}): Promise<{ id: string; name: string; added: number }> {
  const token = await requireToken();
  const created = await sendSpotifyJson<{ id?: string; name?: string }>(
    `${SPOTIFY_API}/me/playlists`,
    token,
    'POST',
    { name: options.name, public: options.isPublic },
  );
  if (!created.id) {
    throw new Error('Spotify did not return the new playlist.');
  }
  const total = options.trackIds.length;
  let added = 0;
  options.onProgress?.({ added, total });
  for (let start = 0; start < total; start += SPOTIFY_PLAYLIST_EDIT_BATCH_SIZE) {
    const batch = options.trackIds.slice(start, start + SPOTIFY_PLAYLIST_EDIT_BATCH_SIZE);
    try {
      await sendSpotifyJson(playlistItemsUrl(created.id), token, 'POST', {
        uris: batch.map(trackUri),
      });
    } catch (error) {
      throw new SpotifyPlaylistPartialCreateError(options.name, added, total, error);
    }
    added += batch.length;
    options.onProgress?.({ added, total });
  }
  return { id: created.id, name: created.name ?? options.name, added };
}
