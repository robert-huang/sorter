import type { MouseEvent } from 'react';
import { buildAnilistFavouriteUrl, buildAnilistMediaUrl } from './anilistSource';
import type { AnilistMediaType } from './types';

/** Canonical AniList URL for a character page (`/character/<id>`). */
export function anilistUrlForCharacter(characterId: number): string {
  return buildAnilistFavouriteUrl('CHARACTERS', characterId);
}

/** Canonical AniList URL for a staff/person page (`/staff/<id>`). */
export function anilistUrlForStaffId(staffId: number): string {
  return buildAnilistFavouriteUrl('STAFF', staffId);
}

/** Canonical AniList URL for a studio page (`/studio/<id>`). */
export function anilistUrlForStudio(studioId: number): string {
  return buildAnilistFavouriteUrl('STUDIOS', studioId);
}

/** Canonical AniList URL for a media page (`/anime|manga/<id>`). */
export function anilistUrlForMediaEntry(type: AnilistMediaType, id: number): string {
  return buildAnilistMediaUrl(type, id);
}

/**
 * AniList anime search filtered by year (always) and season (when set), with
 * the "only show my anime" toggle pre-checked so the result page matches
 * what the seasonal-scores column reflects from the user's own list.
 *
 * Example shapes:
 *  - `/search/anime?year=2020&season=FALL&only%20show%20my%20anime=true`
 *  - `/search/anime?year=2020&only%20show%20my%20anime=true`
 *
 * NOTE: AniList's UI reads the "only show my anime" filter from a query
 * param whose key contains literal spaces — we encode those as %20 (not +)
 * because the AniList front-end's parser doesn't decode +-as-space here.
 */
export function anilistUrlForSeasonSearch(
  season: string | null,
  year: number,
): string {
  const parts: string[] = [];
  if (year > 0) {
    parts.push(`year=${encodeURIComponent(String(year))}`);
  }
  if (season) {
    parts.push(`season=${encodeURIComponent(season.toUpperCase())}`);
  }
  parts.push(
    `${encodeURIComponent('only show my anime')}=true`,
  );
  return `https://anilist.co/search/anime?${parts.join('&')}`;
}

/** True when `url` is a canonical AniList page (not an arbitrary external link). */
export function isAnilistPageUrl(url: string): boolean {
  return /^https:\/\/anilist\.co\//.test(url);
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
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const urls = toUrlList(url);
  const enabled = urls.length > 0;
  return {
    className: enabled ? 'anime-to-anime-anilist-link' : undefined,
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
