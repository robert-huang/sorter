import type { MouseEvent } from 'react';
import {
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from '../lib/importers/anilist/anilistSource';
import type { MediaRow, StaffRow } from '../lib/importers/anilist/types';

const MIDDLE_CLICK_HINT = 'Middle-click to open on AniList';

export function anilistUrlForMedia(media: Pick<MediaRow, 'id' | 'type'>): string {
  return buildAnilistMediaUrl(media.type, media.id);
}

export function anilistUrlForStaff(staff: Pick<StaffRow, 'id'>): string {
  return buildAnilistFavouriteUrl('STAFF', staff.id);
}

/** Middle-click opens AniList in a new tab; left-click behavior is unchanged. */
export function bindAnilistMiddleClick(url: string | null): {
  className: string | undefined;
  title: string | undefined;
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const enabled = Boolean(url);
  return {
    className: enabled ? 'anime-to-anime-anilist-link' : undefined,
    title: enabled ? MIDDLE_CLICK_HINT : undefined,
    onMouseDown: (event) => {
      if (enabled && event.button === 1) {
        event.preventDefault();
      }
    },
    onAuxClick: (event) => {
      if (!enabled || event.button !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      window.open(url!, '_blank', 'noopener,noreferrer');
    },
  };
}

export function mergeAnilistLinkClass(
  base: string,
  linkClass: string | undefined,
): string {
  return linkClass ? `${base} ${linkClass}` : base;
}
