import { useState, type ReactNode } from 'react';
import { useThemeSongPreview } from '../hooks/useThemeSongPreview';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import {
  isSpotifyUnavailableInMarket,
  spotifyOpenUrl,
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
import { usePlaylistEditAction } from '../hooks/usePlaylistEditAction';
import type { ThemeSongPlaylistEditor } from '../hooks/useThemeSongPlaylistEditor';
import {
  isPlaylistAddable,
  isPlaylistRemovable,
} from '../lib/spotify/themeSongPlaylistEditing';

type Props = {
  row: MediaThemeSongRow;
  playlistMatch: PlaylistMatchResult;
  showPlaylistMatch: boolean;
  spotifyCountry?: string | null;
  onExclude?: (row: MediaThemeSongRow) => void;
  mediaId?: number;
  animeTitle?: string;
  /** Enables right-click add/remove on the playlist dot. */
  playlistEditor?: ThemeSongPlaylistEditor | null;
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

type PlaylistDotDescriptor = { modifier: string; tooltip: string };

function playlistDotDescriptor(
  match: PlaylistMatchResult,
  marketUnavailable: boolean,
  spotifyCountry?: string | null,
): PlaylistDotDescriptor | null {
  const isLocalMetadataMatch = match.metadataMatch?.kind === 'local';
  if (marketUnavailable && !isLocalMetadataMatch) {
    return {
      modifier: 'is-market-unavailable',
      tooltip: marketUnavailableTooltip(match, spotifyCountry),
    };
  }
  if (match.metadataMatch) {
    return { modifier: 'is-metadata', tooltip: metadataMatchTooltip(match) };
  }
  if (match.status === 'in') {
    return {
      modifier: 'is-in',
      tooltip: match.playlistPosition
        ? `In your Spotify playlist at #${match.playlistPosition}`
        : 'In your Spotify playlist',
    };
  }
  if (match.status === 'out') {
    return { modifier: 'is-out', tooltip: 'Not in your Spotify playlist' };
  }
  return null;
}

function themeSongPlaylistIndicator(
  match: PlaylistMatchResult,
  marketUnavailable = false,
  spotifyCountry?: string | null,
): ReactNode {
  const dot = playlistDotDescriptor(match, marketUnavailable, spotifyCountry);
  if (!dot) {
    return null;
  }
  return (
    <span
      title={dot.tooltip}
      aria-label={dot.tooltip}
      className={`anilist-detail-theme-song-playlist-dot ${dot.modifier}`}
    />
  );
}

function playlistEditKind(
  match: PlaylistMatchResult,
  editor: ThemeSongPlaylistEditor | null | undefined,
): 'add' | 'remove' | null {
  if (!editor) {
    return null;
  }
  if (isPlaylistAddable(match)) {
    return 'add';
  }
  return editor.allowRemove && isPlaylistRemovable(match) ? 'remove' : null;
}

/**
 * Right-click target for a playlist edit: spinner while busy, a brief x on failure.
 * Removal needs Shift+right-click twice; leaving the indicator disarms it.
 */
export function PlaylistEditIndicator({
  baseClassName,
  modifier,
  tooltip,
  kind,
  playlistName,
  onEdit,
  children,
}: {
  baseClassName: string;
  modifier: string;
  tooltip: string;
  kind: 'add' | 'remove' | null;
  playlistName: string | null;
  onEdit: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const action = usePlaylistEditAction();
  const [removeArmed, setRemoveArmed] = useState(false);
  const armed = removeArmed && kind === 'remove' && action.phase === 'idle';
  const verb = kind === 'remove' ? 'Removing from' : 'Adding to';
  let className = `${baseClassName} ${modifier}`;
  let label = tooltip;
  if (armed) {
    className += ' is-remove-armed';
    label = `Shift+right-click again to remove from ${playlistName ?? 'playlist'}`;
  } else if (action.phase === 'busy') {
    className = `${baseClassName} is-edit-busy`;
    label = `${verb} ${playlistName ?? 'playlist'}…`;
  } else if (action.phase === 'failed') {
    className = `${baseClassName} is-edit-failed`;
  }
  if (kind && action.phase === 'idle') {
    className += kind === 'add' ? ' is-addable' : ' is-removable';
  }
  if (action.error) {
    label = `Couldn't ${kind === 'remove' ? 'remove' : 'add'}: ${action.error}\n\n${label}`;
  }
  return (
    <span
      title={label}
      aria-label={label}
      aria-busy={action.phase === 'busy' || undefined}
      className={className}
      onContextMenu={
        kind
          ? (event) => {
              if (kind === 'remove' && !event.shiftKey) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              if (kind === 'remove' && !armed) {
                setRemoveArmed(true);
                return;
              }
              setRemoveArmed(false);
              action.run(onEdit);
            }
          : undefined
      }
      onMouseLeave={removeArmed ? () => setRemoveArmed(false) : undefined}
    >
      {action.phase === 'failed' ? '✕' : children}
    </span>
  );
}

function playlistEditHint(kind: 'add' | 'remove' | null, playlistName: string): string {
  if (kind === 'add') return `\nRight-click to add to ${playlistName}`;
  if (kind === 'remove') return `\nShift+right-click twice to remove from ${playlistName}`;
  return '';
}

function ThemeSongPlaylistDotSlot({
  row,
  match,
  show,
  marketUnavailable,
  spotifyCountry,
  playlistEditor,
}: {
  row: MediaThemeSongRow;
  match: PlaylistMatchResult;
  show: boolean;
  marketUnavailable: boolean;
  spotifyCountry?: string | null;
  playlistEditor?: ThemeSongPlaylistEditor | null;
}) {
  if (!show && !marketUnavailable) {
    return null;
  }
  const dot = playlistDotDescriptor(match, marketUnavailable, spotifyCountry);
  const kind = playlistEditKind(match, playlistEditor);
  return (
    <div className="anilist-detail-theme-song-playlist-dot-slot">
      {dot ? (
        <PlaylistEditIndicator
          baseClassName="anilist-detail-theme-song-playlist-dot"
          modifier={dot.modifier}
          tooltip={`${dot.tooltip}${playlistEditHint(kind, playlistEditor?.playlistName ?? '')}`}
          kind={kind}
          playlistName={playlistEditor?.playlistName ?? null}
          onEdit={() =>
            kind === 'remove'
              ? playlistEditor!.removeRow(row)
              : playlistEditor!.addRows([row])
          }
        />
      ) : (
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
        href={spotifyOpenUrl(row.spotifyUrl)}
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
  playlistEditor,
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
        row={row}
        playlistEditor={playlistEditor}
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
