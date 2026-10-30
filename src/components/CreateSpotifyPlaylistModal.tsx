import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  createSpotifyPlaylistWithTracks,
  type CreatePlaylistProgress,
} from '../lib/spotify/spotifyPlaylistEdits';
import type { NewPlaylistSong, NewPlaylistSongs } from '../lib/spotify/themeSongPlaylistEditing';
import { ToolSegmentedFilter, type ToolSegmentedOption } from '../tools/ToolSegmentedFilter';

type PlaylistVisibility = 'public' | 'private';

const VISIBILITY_OPTIONS: readonly ToolSegmentedOption<PlaylistVisibility>[] = [
  { value: 'public', label: 'Public', title: 'Shows on your Spotify profile' },
  { value: 'private', label: 'Private', title: 'Only visible to you' },
];

const SONG_TYPE_TAG: Record<NewPlaylistSong['type'], string> = {
  Opening: 'OP',
  Ending: 'ED',
  Insert: 'IN',
};

type Props = {
  defaultName: string;
  /** Summary of the calendar's season and filters. */
  description: string;
  /** Recomputed by the parent as theme songs load, so the summary stays live. */
  songs: NewPlaylistSongs;
  /** Shows in the chart whose theme songs haven't been fetched yet. */
  unloadedShowCount: number;
  loadingUnloaded: boolean;
  onLoadUnloaded: () => void;
  onClose: () => void;
  onCreated: (summary: { name: string; added: number }) => void;
};

function songSummary(songs: NewPlaylistSongs): string {
  const songWord = songs.trackIds.length === 1 ? 'song' : 'songs';
  const showWord = songs.showCount === 1 ? 'show' : 'shows';
  const unavailable =
    songs.unavailableCount > 0 ? ` (${songs.unavailableCount} unavailable in your market)` : '';
  return `${songs.trackIds.length} ${songWord} from ${songs.showCount} ${showWord}${unavailable}`;
}

/** Name + visibility prompt for a new playlist of the Weekly Calendar's shown theme songs. */
export function CreateSpotifyPlaylistModal({
  defaultName,
  description,
  songs,
  unloadedShowCount,
  loadingUnloaded,
  onLoadUnloaded,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<PlaylistVisibility>('public');
  const [progress, setProgress] = useState<CreatePlaylistProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const creating = progress != null && error == null;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || creating) {
      return;
    }
    setError(null);
    setProgress({ added: 0, total: songs.trackIds.length });
    try {
      const result = await createSpotifyPlaylistWithTracks({
        name: trimmed,
        isPublic: visibility === 'public',
        description,
        trackIds: songs.trackIds,
        onProgress: setProgress,
      });
      onCreated({ name: result.name, added: result.added });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the playlist.');
    }
  }

  return (
    <Modal label="Create Spotify playlist" onClose={creating ? () => {} : onClose}>
      <h3>Create Spotify playlist</h3>
      <form
        className="create-playlist-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="tool-field tool-field-label-row create-playlist-field">
          <span className="tool-field-label">Name</span>
          <input
            ref={inputRef}
            type="text"
            className="slot-search create-playlist-name-input"
            value={name}
            disabled={creating}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <ToolSegmentedFilter
          label="Visibility"
          labelId="create-playlist-visibility-label"
          className="create-playlist-field"
          options={VISIBILITY_OPTIONS}
          value={visibility}
          disabled={creating}
          onChange={setVisibility}
        />
        <p className="tool-muted create-playlist-summary" title={description}>
          {songSummary(songs)}
        </p>
        <ol className="create-playlist-shows">
          {songs.shows.map((show) => (
            <li key={show.id}>
              <div className="create-playlist-show-title">{show.title}</div>
              <ul className="create-playlist-songs">
                {show.songs.map((song, index) => (
                  <li
                    key={`${song.type}-${index}`}
                    className={song.unavailable ? 'is-unavailable' : undefined}
                    title={song.unavailable ? 'Unavailable in your Spotify market' : undefined}
                  >
                    <span className="create-playlist-song-type">{SONG_TYPE_TAG[song.type]}</span>
                    {song.title}
                    {song.artist ? <span className="tool-muted"> — {song.artist}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {unloadedShowCount > 0 ? (
          <p className="create-playlist-warning" role="status">
            <span>
              {unloadedShowCount} show{unloadedShowCount === 1 ? '' : 's'} in the chart{' '}
              {unloadedShowCount === 1 ? "hasn't" : "haven't"} loaded theme songs yet, so{' '}
              {unloadedShowCount === 1 ? 'its' : 'their'} songs aren&apos;t included.
            </span>
            <button
              type="button"
              className="btn small"
              onClick={onLoadUnloaded}
              disabled={loadingUnloaded || creating}
            >
              {loadingUnloaded ? 'Loading…' : 'Load them'}
            </button>
          </p>
        ) : null}
        {error ? (
          <p className="settings-status" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={creating || name.trim().length === 0}
          >
            {creating ? `Creating… (${progress.added}/${progress.total})` : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
