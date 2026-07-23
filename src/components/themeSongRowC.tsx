import type { ReactNode } from 'react';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { normalizeSpotifySearchUrl } from '../lib/importers/anilist/themeSongs/spotifyLinks';
import {
  resolveThemeSongArtist,
  resolveThemeSongTitle,
  themeSongInsertEpisodeLine,
  themeSongTypeBadge,
} from '../lib/importers/anilist/themeSongs/themeSongDisplay';
import type { PlaylistMatchStatus } from '../lib/spotify/spotifyPlaylistMatch';
import { useThemeSongDisplayPreferences } from '../hooks/useThemeSongDisplayPreferences';

type Props = {
  row: MediaThemeSongRow;
  playlistStatus: PlaylistMatchStatus;
  showPlaylistMatch: boolean;
};

export function ThemeSongPlaylistDot({ status }: { status: PlaylistMatchStatus }) {
  return themeSongPlaylistIndicator(status);
}

function themeSongPlaylistIndicator(status: PlaylistMatchStatus): ReactNode {
  if (status === 'in') {
    return (
      <span
        title="In your Spotify playlist"
        aria-label="In your Spotify playlist"
        className="anilist-detail-theme-song-playlist-dot is-in"
      >
        ●
      </span>
    );
  }
  if (status === 'out') {
    return (
      <span
        title="Not in your Spotify playlist"
        aria-label="Not in your Spotify playlist"
        className="anilist-detail-theme-song-playlist-dot is-out"
      >
        ●
      </span>
    );
  }
  return null;
}

function ThemeSongTitleLink({
  row,
  title,
}: {
  row: MediaThemeSongRow;
  title: string;
}) {
  if (row.spotifyUrl) {
    return (
      <a
        href={normalizeSpotifySearchUrl(row.spotifyUrl)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {title}
      </a>
    );
  }
  return <>{title}</>;
}

function ThemeSongOpEdLine({
  row,
  title,
  artist,
}: {
  row: MediaThemeSongRow;
  title: string;
  artist: string | null;
}) {
  return (
    <span className="anilist-detail-theme-song-line">
      <ThemeSongTitleLink row={row} title={title} />
      {artist ? (
        <>
          <span className="anilist-detail-theme-song-sep"> - </span>
          <span>{artist}</span>
        </>
      ) : null}
    </span>
  );
}

function ThemeSongInsertLines({
  row,
  title,
  artist,
}: {
  row: MediaThemeSongRow;
  title: string;
  artist: string | null;
}) {
  const episodeLine = themeSongInsertEpisodeLine(row);
  return (
    <div className="anilist-detail-theme-song-insert-body">
      <span className="anilist-detail-theme-song-line">
        <ThemeSongTitleLink row={row} title={title} />
        {artist ? (
          <>
            <span className="anilist-detail-theme-song-sep"> - </span>
            <span>{artist}</span>
          </>
        ) : null}
      </span>
      {episodeLine ? (
        <div className="anilist-detail-theme-song-insert-ep">{episodeLine}</div>
      ) : null}
    </div>
  );
}

export function ThemeSongRowC({ row, playlistStatus, showPlaylistMatch }: Props) {
  const { mode } = useThemeSongDisplayPreferences();
  const title = resolveThemeSongTitle(row, mode);
  const artist = resolveThemeSongArtist(row, mode);
  const isInsert = row.type === 'Insert';
  return (
    <li
      className={`anilist-detail-theme-song-item${isInsert ? ' is-insert' : ''}`}
    >
      <div className="anilist-detail-theme-song-type" aria-hidden="true">
        {themeSongTypeBadge(row)}
      </div>
      <div className="anilist-detail-theme-song-text">
        {showPlaylistMatch ? themeSongPlaylistIndicator(playlistStatus) : null}
        {isInsert ? (
          <ThemeSongInsertLines row={row} title={title} artist={artist} />
        ) : (
          <ThemeSongOpEdLine row={row} title={title} artist={artist} />
        )}
      </div>
    </li>
  );
}
