import {
  anilistUrlForCharacter,
  anilistUrlForMediaEntry,
  anilistUrlForStaffId,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../lib/importers/anilist/anilistLinks';
import type { AnilistMediaType } from '../lib/importers/anilist/types';
import { UserIcon } from '../components/icons';
import type { ToolPanelProps } from './toolTypes';

type EntityAvatarProps = {
  imageUrl?: string | null;
  label: string;
  /** Round for people; poster uses a slight radius for show covers. */
  variant?: 'round' | 'poster';
};

export function ToolEntityAvatar({
  imageUrl,
  label,
  variant = 'round',
}: EntityAvatarProps) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        className={`tool-entity-avatar tool-entity-avatar--${variant}`}
        loading="lazy"
      />
    );
  }

  const initial = label.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className={`tool-entity-avatar tool-entity-avatar--${variant} tool-entity-avatar--placeholder`}
      aria-hidden="true"
    >
      {variant === 'round' ? <UserIcon size={14} /> : initial}
    </span>
  );
}

type ToolShowButtonProps = {
  mediaId: number;
  title: string;
  coverImage?: string | null;
  mediaType?: AnilistMediaType;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  compact?: boolean;
  className?: string;
};

/** Cover + title chip that opens the media detail modal (left) or AniList (middle). */
export function ToolShowButton({
  mediaId,
  title,
  coverImage,
  mediaType = 'ANIME',
  onOpenMedia,
  compact = false,
  className,
}: ToolShowButtonProps) {
  const anilistLink = bindAnilistMiddleClick(anilistUrlForMediaEntry(mediaType, mediaId));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass(
        [
          'tool-entity-btn',
          compact ? 'tool-entity-btn--compact' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' '),
        anilistLink.className,
      )}
      title={title}
      onClick={() => onOpenMedia(mediaId, title)}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      <ToolEntityAvatar imageUrl={coverImage} label={title} variant="poster" />
      <span className="tool-entity-label">
        <strong>{title}</strong>
      </span>
    </button>
  );
}

type ToolStaffButtonProps = {
  staffId: number;
  name: string;
  imageUrl?: string | null;
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  compact?: boolean;
  className?: string;
};

/** Staff/VA avatar + name chip that opens the staff detail modal (left) or AniList (middle). */
export function ToolStaffButton({
  staffId,
  name,
  imageUrl,
  onOpenStaff,
  compact = false,
  className,
}: ToolStaffButtonProps) {
  const anilistLink = bindAnilistMiddleClick(anilistUrlForStaffId(staffId));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass(
        [
          'tool-entity-btn',
          compact ? 'tool-entity-btn--compact' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' '),
        anilistLink.className,
      )}
      title={`View ${name}'s filmography`}
      onClick={() => onOpenStaff(staffId, name)}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      <ToolEntityAvatar imageUrl={imageUrl} label={name} variant="round" />
      <span className="tool-entity-label">
        <strong>{name}</strong>
      </span>
    </button>
  );
}

type ToolCharacterNameProps = {
  characterId: number;
  name: string;
};

/** Character name with middle-click to open AniList (no in-app character modal). */
export function ToolCharacterName({ characterId, name }: ToolCharacterNameProps) {
  const anilistLink = bindAnilistMiddleClick(anilistUrlForCharacter(characterId));

  if (!anilistLink.className) {
    return <span>{name}</span>;
  }

  return (
    <span
      className={mergeAnilistLinkClass(
        'anilist-detail-character-name',
        anilistLink.className,
      )}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      {name}
    </span>
  );
}
