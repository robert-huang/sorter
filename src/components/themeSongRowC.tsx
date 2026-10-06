import type { ReactNode } from 'react';
import { useThemeSongPreview } from '../hooks/useThemeSongPreview';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import {
  isSpotifyUnavailableInMarket,
  normalizeSpotifyUrl,
} from '../lib/importers/anilist/themeSongs/spotifyLinks';
import {
  resolveThemeSongArtist,
  resolveThemeSongTitle,
  themeSongEpisodeLine,
  themeSongTypeBadge,
} from '../lib/importers/anilist/themeSongs/themeSongDisplay';
import type { PlaylistMatchResult } from '../lib/spotify/spotifyPlaylistMatch';
import { useThemeSongDisplayPreferences } from '../hooks/useThemeSongDisplayPreferences';
import { RemoveGlyph } from './RemoveGlyph';
import { ThemeSongPreviewPlayer } from './ThemeSongPreviewPlayer';

type Props = {
  row: MediaThemeSongRow;
  playlistMatch: PlaylistMatchResult;
  showPlaylistMatch: boolean;
  spotifyCountry?: string | null;
  onExclude?: (row: MediaThemeSongRow) => void;
  mediaId?: number;
  animeTitle?: string;
};

export function ThemeSongPlaylistDot({
  match,
  marketUnavailable = false,
  spotifyCountry,
}: {
  match: PlaylistMatchResult;
  marketUnavailable?: boolean;
  spotifyCountry?: string | null;
}) {
  return themeSongPlaylistIndicator(match, marketUnavailable, spotifyCountry);
}

function metadataMatchTooltip(match: PlaylistMatchResult): string {
  const metadataMatch = match.metadataMatch;
  if (!metadataMatch) {
    return '';
  }
  const { track } = metadataMatch;
  const artists = track.artists.length > 0 ? track.artists.join(', ') : 'Unknown artist';
  const position =
    track.playlistPosition > 0 ? `#${track.playlistPosition} · ` : '';
  const prefix =
    metadataMatch.kind === 'local'
      ? 'Matched playlist local file'
      : 'Matched Spotify playlist track by title/artist';
  return `${prefix}: \n\n${position}${track.title} — ${artists}`;
}

function marketUnavailableTooltip(
  match: PlaylistMatchResult,
  spotifyCountry: string | null | undefined,
): string {
  const market = spotifyCountry ? ` (${spotifyCountry})` : '';
  if (match.status === 'in') {
    const position = match.playlistPosition ?? match.metadataMatch?.track.playlistPosition;
    const playlistLocation = position ? ` at #${position}` : '';
    return `In your Spotify playlist${playlistLocation}, but unavailable in your market${market}`;
  }
  return `On Spotify, but unavailable in your market${market}`;
}

function themeSongPlaylistIndicator(
  match: PlaylistMatchResult,
  marketUnavailable = false,
  spotifyCountry?: string | null,
): ReactNode {
  const isLocalMetadataMatch = match.metadataMatch?.kind === 'local';
  if (marketUnavailable && !isLocalMetadataMatch) {
    const tooltip = marketUnavailableTooltip(match, spotifyCountry);
    return (
      <span
        title={tooltip}
        aria-label={tooltip}
        className="anilist-detail-theme-song-playlist-dot is-market-unavailable"
      />
    );
  }
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
    const tooltip = match.playlistPosition
      ? `In your Spotify playlist at #${match.playlistPosition}`
      : 'In your Spotify playlist';
    return (
      <span
        title={tooltip}
        aria-label={tooltip}
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
  marketUnavailable,
  spotifyCountry,
}: {
  match: PlaylistMatchResult;
  show: boolean;
  marketUnavailable: boolean;
  spotifyCountry?: string | null;
}) {
  if (!show && !marketUnavailable) {
    return null;
  }
  const dot = themeSongPlaylistIndicator(match, marketUnavailable, spotifyCountry);
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
        href={normalizeSpotifyUrl(row.spotifyUrl)}
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
  previewToggle,
  previewPanel,
}: {
  row: MediaThemeSongRow;
  title: string;
  artist: string | null;
  previewToggle: ReactNode;
  previewPanel: ReactNode;
}) {
  const episodeLine = themeSongEpisodeLine(row);
  const useStackedLayout =
    row.type === 'Insert' || episodeLine !== null || previewPanel !== null;
  return (
    <div className={useStackedLayout ? 'anilist-detail-theme-song-insert-body' : undefined}>
      <span className="anilist-detail-theme-song-line">
        <ThemeSongTitleLink row={row} title={title} />
        {previewToggle}
        {artist ? (
          <>
            <span className="anilist-detail-theme-song-sep"> - </span>
            <span>{artist}</span>
          </>
        ) : null}
      </span>
      {previewPanel}
      {episodeLine ? (
        <div className="anilist-detail-theme-song-insert-ep">{episodeLine}</div>
      ) : null}
    </div>
  );
}

export function ThemeSongRowC({
  row,
  playlistMatch,
  showPlaylistMatch,
  spotifyCountry,
  onExclude,
  mediaId,
  animeTitle,
}: Props) {
  const { mode } = useThemeSongDisplayPreferences();
  const title = resolveThemeSongTitle(row, mode);
  const artist = resolveThemeSongArtist(row, mode);
  const englishTitle = resolveThemeSongTitle(row, 'english');
  const englishArtist = resolveThemeSongArtist(row, 'english');
  const previewEnabled =
    mediaId != null && typeof animeTitle === 'string' && animeTitle.trim().length > 0;
  const preview = useThemeSongPreview({
    enabled: previewEnabled,
    mediaId: mediaId ?? 0,
    animeTitle: animeTitle?.trim() ?? '',
    row,
    songTitle: englishTitle,
    songArtist: englishArtist,
  });
  const previewFailed = preview.status === 'unavailable' || preview.status === 'error';
  const previewToggle = previewEnabled ? (
    <button
      type="button"
      className={[
        'anilist-detail-theme-song-preview-toggle',
        previewFailed ? 'is-failed' : '',
        preview.status === 'ready' ? 'is-ready' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={(event) => {
        event.stopPropagation();
        void preview.togglePreview();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void preview.retryPreview();
      }}
      aria-expanded={preview.playerOpen}
      aria-label={
        previewFailed
          ? 'Song preview unavailable'
          : preview.playerOpen
            ? 'Close song preview'
            : 'Play song preview'
      }
      title={
        preview.playerOpen
          ? 'Close preview'
          : previewFailed
            ? preview.failureTooltip
            : preview.failureTooltip
      }
    >
      {preview.status === 'loading' ? '…' : '▶'}
    </button>
  ) : null;
  const previewPanel =
    preview.playerOpen && preview.status === 'ready' && preview.urls ? (
      <ThemeSongPreviewPlayer urls={preview.urls} label={`${title} preview`} />
    ) : preview.playerOpen && preview.status === 'loading' ? (
      <p className="anilist-detail-theme-song-preview-loading">Loading preview…</p>
    ) : null;
  const isInsert = row.type === 'Insert';
  const marketUnavailable = isSpotifyUnavailableInMarket(
    row.spotifyAvailableMarkets,
    spotifyCountry,
  );
  return (
    <li
      className={`anilist-detail-theme-song-item${isInsert ? ' is-insert' : ''}`}
    >
      <div className="anilist-detail-theme-song-type" aria-hidden="true">
        {themeSongTypeBadge(row)}
      </div>
      <ThemeSongPlaylistDotSlot
        match={playlistMatch}
        show={showPlaylistMatch || spotifyCountry != null}
        marketUnavailable={marketUnavailable}
        spotifyCountry={spotifyCountry}
      />
      <div className="anilist-detail-theme-song-text">
        <ThemeSongBody
          row={row}
          title={title}
          artist={artist}
          previewToggle={previewToggle}
          previewPanel={previewPanel}
        />
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
