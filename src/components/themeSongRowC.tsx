import type { ReactNode } from 'react';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { normalizeSpotifySearchUrl } from '../lib/importers/anilist/themeSongs/spotifyLinks';
import {
  resolveThemeSongArtist,
  resolveThemeSongTitle,
  themeSongEpisodeLine,
  themeSongTypeBadge,
} from '../lib/importers/anilist/themeSongs/themeSongDisplay';
import type { PlaylistMatchResult } from '../lib/spotify/spotifyPlaylistMatch';
import { useThemeSongDisplayPreferences } from '../hooks/useThemeSongDisplayPreferences';
import { RemoveGlyph } from './RemoveGlyph';

type Props = {
  row: MediaThemeSongRow;
  playlistMatch: PlaylistMatchResult;
  showPlaylistMatch: boolean;
  onExclude?: (row: MediaThemeSongRow) => void;
};

export function ThemeSongPlaylistDot({ match }: { match: PlaylistMatchResult }) {
  return themeSongPlaylistIndicator(match);
}

function metadataMatchTooltip(match: PlaylistMatchResult): string {
  const metadataMatch = match.metadataMatch;
  if (!metadataMatch) {
    return '';
  }
  const { track } = metadataMatch;
  const artists = track.artists.length > 0 ? track.artists.join(', ') : 'Unknown artist';
  const position =
    track.playlistPosition > 0 ? `#${track.playlistPosition}. ` : '';
  const prefix =
    metadataMatch.kind === 'local'
      ? 'Matched playlist local file'
      : 'Matched Spotify playlist track by title/artist';
  return `${prefix}: \n\n${position}${track.title} — ${artists}`;
}

function themeSongPlaylistIndicator(match: PlaylistMatchResult): ReactNode {
  if (match.metadataMatch) {
    const tooltip = metadataMatchTooltip(match);
    return (
      <span
        title={tooltip}
        aria-label={tooltip}
        className="anilist-detail-theme-song-playlist-dot is-metadata"
      />
    );
  }
  if (match.status === 'in') {
    return (
      <span
        title="In your Spotify playlist"
        aria-label="In your Spotify playlist"
        className="anilist-detail-theme-song-playlist-dot is-in"
      />
    );
  }
  if (match.status === 'out') {
    return (
      <span
        title="Not in your Spotify playlist"
        aria-label="Not in your Spotify playlist"
        className="anilist-detail-theme-song-playlist-dot is-out"
      />
    );
  }
  return null;
}

function ThemeSongPlaylistDotSlot({
  match,
  show,
}: {
  match: PlaylistMatchResult;
  show: boolean;
}) {
  if (!show) {
    return null;
  }
  const dot = themeSongPlaylistIndicator(match);
  return (
    <div className="anilist-detail-theme-song-playlist-dot-slot">
      {dot ?? (
        <span className="anilist-detail-theme-song-playlist-dot is-placeholder" aria-hidden="true" />
      )}
    </div>
  );
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

function ThemeSongBody({
  row,
  title,
  artist,
}: {
  row: MediaThemeSongRow;
  title: string;
  artist: string | null;
}) {
  const episodeLine = themeSongEpisodeLine(row);
  const useStackedLayout = row.type === 'Insert' || episodeLine !== null;
  return (
    <div className={useStackedLayout ? 'anilist-detail-theme-song-insert-body' : undefined}>
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

export function ThemeSongRowC({ row, playlistMatch, showPlaylistMatch, onExclude }: Props) {
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
      <ThemeSongPlaylistDotSlot match={playlistMatch} show={showPlaylistMatch} />
      <div className="anilist-detail-theme-song-text">
        <ThemeSongBody row={row} title={title} artist={artist} />
      </div>
      {onExclude ? (
        <button
          type="button"
          className="x-button anilist-detail-theme-song-exclude"
          onClick={() => onExclude(row)}
          title="Remove this song from this entry"
          aria-label="Remove this song from this entry"
        >
          <RemoveGlyph size={12} />
        </button>
      ) : null}
    </li>
  );
}
