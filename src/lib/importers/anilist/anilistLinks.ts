import type { MouseEvent } from 'react';
import { buildAnilistFavouriteUrl, buildAnilistMediaUrl } from './anilistSource';
import type { AnilistMediaType } from './types';

const MIDDLE_CLICK_HINT = 'Middle-click to open on AniList';

/** Canonical AniList URL for a character page (`/character/<id>`). */
export function anilistUrlForCharacter(characterId: number): string {
  return buildAnilistFavouriteUrl('CHARACTERS', characterId);
}

/** Canonical AniList URL for a staff/person page (`/staff/<id>`). */
export function anilistUrlForStaffId(staffId: number): string {
  return buildAnilistFavouriteUrl('STAFF', staffId);
}

/** Canonical AniList URL for a media page (`/anime|manga/<id>`). */
export function anilistUrlForMediaEntry(type: AnilistMediaType, id: number): string {
  return buildAnilistMediaUrl(type, id);
}

function toUrlList(url: string | readonly string[] | null): string[] {
  if (url == null) {
    return [];
  }
  if (typeof url === 'string') {
    return url ? [url] : [];
  }
  return url.filter((u): u is string => Boolean(u));
}

/**
 * Middle-click opens AniList in a new tab; left-click behavior is unchanged.
 * Accepts a single URL, a list of URLs (each opened in its own tab — used by
 * the path arrows, where one VA hop can cover several characters), or `null`
 * to disable the affordance.
 */
export function bindAnilistMiddleClick(url: string | readonly string[] | null): {
  className: string | undefined;
  title: string | undefined;
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const urls = toUrlList(url);
  const enabled = urls.length > 0;
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
      for (const u of urls) {
        window.open(u, '_blank', 'noopener,noreferrer');
      }
    },
  };
}

export function mergeAnilistLinkClass(
  base: string,
  linkClass: string | undefined,
): string {
  return linkClass ? `${base} ${linkClass}` : base;
}
