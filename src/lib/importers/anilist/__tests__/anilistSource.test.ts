/**
 * Coverage for the AniList source-level URL builders. Both builders
 * deliberately produce the bare `/<kind>/<id>` form (no trailing
 * slug) because anilist.co 30x-redirects to the canonical slugged
 * URL server-side. Tests pin both the mapping table AND the bare-id
 * form so a future refactor that "helpfully" appends a slug breaks
 * loudly here instead of in the URL bar.
 */

import { describe, expect, it } from 'vitest';
import {
  ANILIST_ENTITY_PATH,
  ANILIST_SITE_ORIGIN,
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from '../anilistSource';

describe('ANILIST_ENTITY_PATH', () => {
  it('maps every entity kind to its canonical anilist.co path segment', () => {
    // Pin the exact strings — AniList's URL scheme is stable but
    // these path segments are user-facing (a typo here would route
    // every clicked link to a 404).
    expect(ANILIST_ENTITY_PATH).toEqual({
      ANIME: 'anime',
      MANGA: 'manga',
      CHARACTERS: 'character',
      STAFF: 'staff',
      STUDIOS: 'studio',
    });
  });
});

describe('buildAnilistMediaUrl', () => {
  it('builds anime URLs as origin + /anime/<id>', () => {
    expect(buildAnilistMediaUrl('ANIME', 1)).toBe(
      `${ANILIST_SITE_ORIGIN}/anime/1`,
    );
    expect(buildAnilistMediaUrl('ANIME', 21)).toBe(
      `${ANILIST_SITE_ORIGIN}/anime/21`,
    );
  });

  it('builds manga URLs as origin + /manga/<id>', () => {
    expect(buildAnilistMediaUrl('MANGA', 30002)).toBe(
      `${ANILIST_SITE_ORIGIN}/manga/30002`,
    );
  });

  it('never appends a trailing slug (anilist.co handles canonicalisation server-side)', () => {
    // Pin the no-slug form — adding one client-side would force us
    // to fetch + URL-encode a title which would break for cases
    // where every title column is null.
    const url = buildAnilistMediaUrl('ANIME', 42);
    expect(url.endsWith('/anime/42')).toBe(true);
    expect(url).not.toMatch(/\/anime\/42\/.+$/);
  });
});

describe('buildAnilistFavouriteUrl', () => {
  it('reuses the media URL scheme for ANIME and MANGA favourites', () => {
    expect(buildAnilistFavouriteUrl('ANIME', 1)).toBe(
      buildAnilistMediaUrl('ANIME', 1),
    );
    expect(buildAnilistFavouriteUrl('MANGA', 2)).toBe(
      buildAnilistMediaUrl('MANGA', 2),
    );
  });

  it('builds character URLs as origin + /character/<id>', () => {
    expect(buildAnilistFavouriteUrl('CHARACTERS', 137)).toBe(
      `${ANILIST_SITE_ORIGIN}/character/137`,
    );
  });

  it('builds staff URLs as origin + /staff/<id>', () => {
    expect(buildAnilistFavouriteUrl('STAFF', 95269)).toBe(
      `${ANILIST_SITE_ORIGIN}/staff/95269`,
    );
  });

  it('builds studio URLs as origin + /studio/<id>', () => {
    expect(buildAnilistFavouriteUrl('STUDIOS', 14)).toBe(
      `${ANILIST_SITE_ORIGIN}/studio/14`,
    );
  });
});
