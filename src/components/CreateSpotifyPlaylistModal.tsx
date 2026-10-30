import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  createSpotifyPlaylistWithTracks,
  type CreatePlaylistProgress,
} from '../lib/spotify/spotifyPlaylistEdits';
import type { NewPlaylistSongs } from '../lib/spotify/themeSongPlaylistEditing';

type Props = {
  defaultName: string;
  songs: NewPlaylistSongs;
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
export function CreateSpotifyPlaylistModal({ defaultName, songs, onClose, onCreated }: Props) {
  const [name, setName] = useState(defaultName);
  const [isPublic, setIsPublic] = useState(true);
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
        isPublic,
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
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="settings-item">
          <span>Name</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            disabled={creating}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label
          className="settings-item checkbox"
          title="Public playlists show on your Spotify profile. Private ones are only visible to you."
        >
          <input
            type="checkbox"
            checked={isPublic}
            disabled={creating}
            onChange={(event) => setIsPublic(event.target.checked)}
          />
          Public
        </label>
        <p className="tool-muted">{songSummary(songs)}</p>
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
