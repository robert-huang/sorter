import {
  anilistUrlForCharacter,
  anilistUrlForMediaEntry,
  anilistUrlForStaffId,
  anilistUrlForStudio,
} from '../lib/importers/anilist/anilistLinks';
import { AnilistMiddleClickLink } from '../lib/importers/anilist/AnilistMiddleClickLink';
import type { AnilistMediaType } from '../lib/importers/anilist/types';
import { UserIcon } from '../components/icons';
import type { ToolPanelProps } from './toolTypes';

export function appendFavouriteStar(label: string, favourite: boolean): string {
  return favourite ? `${label} ★` : label;
}

/** AniList repeat is additional completions, so one repeat means two total watches. */
export function formatRepeatSuffix(repeat: number | null | undefined): string {
  return repeat != null && repeat > 0 ? ` ×${Math.floor(repeat) + 1}` : '';
}

/** Keep the star attached to a character name before a trailing role label. */
export function appendFavouriteStarBeforeRole(
  label: string,
  favourite: boolean,
): string {
  if (!favourite) {
    return label;
  }
  const roleSuffix = label.match(/^(.*?)(\s+\([^()]+\))$/);
  return roleSuffix
    ? `${roleSuffix[1]} ★${roleSuffix[2]}`
    : appendFavouriteStar(label, true);
}

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
  /** When true, omit the cover/poster (e.g. when rendered in a sibling column). */
  hideAvatar?: boolean;
  className?: string;
  favourite?: boolean;
  labelSuffix?: React.ReactNode;
};

/** Cover + title chip that opens the media detail modal (left) or AniList (middle). */
export function ToolShowButton({
  mediaId,
  title,
  coverImage,
  mediaType = 'ANIME',
  onOpenMedia,
  compact = false,
  hideAvatar = false,
  className,
  favourite,
  labelSuffix,
}: ToolShowButtonProps) {
  return (
    <AnilistMiddleClickLink
      url={anilistUrlForMediaEntry(mediaType, mediaId)}
      className={[
        'tool-entity-btn',
        compact ? 'tool-entity-btn--compact' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={title}
      onPrimaryClick={() => onOpenMedia(mediaId, title)}
    >
      {hideAvatar ? null : (
        <ToolEntityAvatar imageUrl={coverImage} label={title} variant="poster" />
      )}
      <span className="tool-entity-label">
        <strong
          className={
            favourite === undefined
              ? undefined
              : `anilist-detail-media-title${
                  favourite ? ' anilist-detail-media-title--favourite' : ''
                }`
          }
        >
          {appendFavouriteStar(title, favourite === true)}
          {labelSuffix}
        </strong>
      </span>
    </AnilistMiddleClickLink>
  );
}

type ToolStaffButtonProps = {
  staffId: number;
  name: string;
  imageUrl?: string | null;
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  compact?: boolean;
  className?: string;
  /** When set, colours the name (male: cornflowerblue, female: plum). */
  gender?: string | null;
  favourite?: boolean;
};

function staffGenderButtonClass(gender: string | null | undefined): string {
  const normalized = (gender ?? '').toLowerCase();
  if (normalized === 'male') {
    return 'tool-entity-btn--staff-male';
  }
  if (normalized === 'female') {
    return 'tool-entity-btn--staff-female';
  }
  return '';
}

/** Staff/VA avatar + name chip that opens the staff detail modal (left) or AniList (middle). */
export function ToolStaffButton({
  staffId,
  name,
  imageUrl,
  onOpenStaff,
  compact = false,
  className,
  gender,
  favourite,
}: ToolStaffButtonProps) {
  return (
    <AnilistMiddleClickLink
      url={anilistUrlForStaffId(staffId)}
      className={[
        'tool-entity-btn',
        compact ? 'tool-entity-btn--compact' : '',
        staffGenderButtonClass(gender),
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={`View ${name}'s filmography`}
      onPrimaryClick={() => onOpenStaff(staffId, name)}
    >
      <ToolEntityAvatar imageUrl={imageUrl} label={name} variant="round" />
      <span className="tool-entity-label">
        <strong
          className={
            favourite === undefined
              ? undefined
              : `tool-entity-person-name anilist-detail-person-link${
                  favourite ? ' anilist-detail-person-link--favourite' : ''
                }`
          }
        >
          {appendFavouriteStar(name, favourite === true)}
        </strong>
      </span>
    </AnilistMiddleClickLink>
  );
}

type ToolCharacterNameProps = {
  characterId: number;
  name: string;
  /** When set, colours the name (male: cornflowerblue, female: plum). */
  gender?: string | null;
  favourite?: boolean;
};

function characterGenderLinkClass(gender: string | null | undefined): string {
  const normalized = (gender ?? '').toLowerCase();
  if (normalized === 'male') {
    return 'tool-character-name-link--male';
  }
  if (normalized === 'female') {
    return 'tool-character-name-link--female';
  }
  return '';
}

/** Character name with middle-click to open AniList (no in-app character modal). */
export function ToolCharacterName({
  characterId,
  name,
  gender,
  favourite,
}: ToolCharacterNameProps) {
  return (
    <AnilistMiddleClickLink
      url={anilistUrlForCharacter(characterId)}
      className={[
        'tool-character-name-link',
        favourite === undefined ? '' : 'anilist-detail-character-name',
        favourite ? 'anilist-detail-character-name--favourite' : '',
        characterGenderLinkClass(gender),
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {appendFavouriteStar(name, favourite === true)}
    </AnilistMiddleClickLink>
  );
}

type ToolStudioNameProps = {
  studioId: number;
  name: string;
  favourite?: boolean;
};

/** Studio name with middle-click to open AniList (no in-app studio modal). */
export function ToolStudioName({ studioId, name, favourite }: ToolStudioNameProps) {
  return (
    <AnilistMiddleClickLink
      url={anilistUrlForStudio(studioId)}
      className={[
        'tool-character-name-link',
        favourite === undefined ? '' : 'anilist-detail-tag-item-studio',
        favourite ? 'anilist-detail-tag-item-studio--favourite' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {appendFavouriteStar(name, favourite === true)}
    </AnilistMiddleClickLink>
  );
}

/** Comma-separated or stacked character names with middle-click AniList links. */
export function CharacterNameInlineList({
  characters,
  className,
  layout = 'inline',
}: {
  characters: Array<{ id: number; name: string; gender?: string | null }>;
  className?: string;
  layout?: 'inline' | 'stacked';
}) {
  if (characters.length === 0) {
    return null;
  }

  if (layout === 'stacked') {
    return (
      <div
        className={['character-name-inline-list--stacked', className]
          .filter(Boolean)
          .join(' ')}
      >
        {characters.map((character) => (
          <div key={character.id} className="character-name-inline-list__line">
            <ToolCharacterName
              characterId={character.id}
              name={character.name}
              gender={character.gender}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <span className={className}>
      {characters.map((character, index) => (
        <span key={character.id}>
          {index > 0 ? ', ' : null}
          <ToolCharacterName
            characterId={character.id}
            name={character.name}
            gender={character.gender}
          />
        </span>
      ))}
    </span>
  );
}
