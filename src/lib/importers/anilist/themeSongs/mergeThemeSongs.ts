import type { AniplaylistHit } from './aniplaylistApi';
import { isAniplaylistThemeType } from './aniplaylistApi';
import type { ParsedMalTheme } from './malThemeParser';
import {
  buildSpotifySearchUrl,
  collectSpotifyTrackIds,
  parseSpotifyTrackIdFromUrl,
  pickSpotifyLink,
} from './spotifyLinks';
import type { MediaThemeSongRow, ThemeSongType } from './types';
import { THEME_SONG_TYPE_ORDER } from './types';

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function malMatchKey(theme: ParsedMalTheme): string {
  return `${theme.type}\0${normalizeKey(theme.title)}\0${normalizeKey(theme.artist ?? '')}`;
}

function titlesRoughlyMatch(a: string, b: string): boolean {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (!na || !nb) {
    return false;
  }
  return na === nb || na.includes(nb) || nb.includes(na);
}

function malMatchesAni(mal: ParsedMalTheme, hit: AniplaylistHit): boolean {
  if (mal.type !== hit.song_type) {
    return false;
  }
  const titleOk = hit.titles.some((t) => titlesRoughlyMatch(t, mal.title));
  if (!titleOk) {
    return false;
  }
  if (!mal.artist) {
    return true;
  }
  return (hit.artists ?? []).some((a) =>
    (a.names ?? []).some((n) => titlesRoughlyMatch(n, mal.artist ?? '')),
  );
}

function hitToPartialRow(hit: AniplaylistHit, sortOrder: number): MediaThemeSongRow {
  const spotifyUrl = pickSpotifyLink(hit.links ?? []);
  const trackIds = collectSpotifyTrackIds(hit.links ?? [], hit.other_link_ids, spotifyUrl);
  const primaryTitle = hit.titles[0] ?? hit.song_key;
  const artist = hit.artists?.[0]?.names?.[0] ?? null;
  const resolvedUrl =
    spotifyUrl ??
    buildSpotifySearchUrl(primaryTitle, artist);

  return {
    type: hit.song_type as ThemeSongType,
    sortOrder,
    songKey: hit.song_key,
    aniTitles: hit.titles,
    aniArtists: (hit.artists ?? []).flatMap((a) => a.names ?? []),
    aniplaylistUrl: hit.short_link,
    displayTitle: primaryTitle,
    displayArtist: artist,
    spotifyUrl: resolvedUrl,
    spotifyTrackIds: trackIds,
    spotifyIsrc: null,
    hasResolvableTrackId: trackIds.length > 0,
  };
}

function malToPartialRow(mal: ParsedMalTheme): MediaThemeSongRow {
  const resolvedUrl = buildSpotifySearchUrl(mal.title, mal.artist);
  return {
    type: mal.type,
    sortOrder: mal.sortOrder,
    malRaw: mal.raw,
    malTitle: mal.title,
    malArtist: mal.artist ?? undefined,
    malEpisodes: mal.episodes ?? undefined,
    displayTitle: mal.title,
    displayArtist: mal.artist,
    spotifyUrl: resolvedUrl,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
  };
}

function mergePair(mal: ParsedMalTheme, hit: MediaThemeSongRow): MediaThemeSongRow {
  const spotifyUrl =
    hit.spotifyTrackIds.length > 0
      ? hit.spotifyUrl
      : buildSpotifySearchUrl(mal.title, mal.artist);
  return {
    ...hit,
    type: mal.type,
    sortOrder: mal.sortOrder,
    malRaw: mal.raw,
    malTitle: mal.title,
    malArtist: mal.artist ?? undefined,
    malEpisodes: mal.episodes ?? undefined,
    displayTitle: mal.title || hit.displayTitle,
    displayArtist: mal.artist ?? hit.displayArtist,
    spotifyUrl,
  };
}

export function mergeThemeSongs(
  malThemes: readonly ParsedMalTheme[],
  aniHits: readonly AniplaylistHit[],
): MediaThemeSongRow[] {
  const themeHits = aniHits.filter((h) => isAniplaylistThemeType(h.song_type));
  const matchedAni = new Set<number>();
  const matchedMal = new Set<string>();
  const rows: MediaThemeSongRow[] = [];

  for (const mal of malThemes) {
    const key = malMatchKey(mal);
    let bestHit: AniplaylistHit | null = null;
    for (const hit of themeHits) {
      if (matchedAni.has(hit.id)) {
        continue;
      }
      if (malMatchesAni(mal, hit)) {
        bestHit = hit;
        break;
      }
    }
    if (bestHit) {
      matchedAni.add(bestHit.id);
      matchedMal.add(key);
      rows.push(mergePair(mal, hitToPartialRow(bestHit, mal.sortOrder)));
    } else {
      matchedMal.add(key);
      rows.push(malToPartialRow(mal));
    }
  }

  themeHits.forEach((hit, index) => {
    if (matchedAni.has(hit.id)) {
      return;
    }
    rows.push(hitToPartialRow(hit, 1000 + index));
  });

  rows.sort((a, b) => {
    const typeCmp =
      THEME_SONG_TYPE_ORDER.indexOf(a.type) - THEME_SONG_TYPE_ORDER.indexOf(b.type);
    if (typeCmp !== 0) {
      return typeCmp;
    }
    return a.sortOrder - b.sortOrder;
  });

  return rows;
}

export function sortThemeRows(rows: readonly MediaThemeSongRow[]): MediaThemeSongRow[] {
  return [...rows].sort((a, b) => {
    const typeCmp =
      THEME_SONG_TYPE_ORDER.indexOf(a.type) - THEME_SONG_TYPE_ORDER.indexOf(b.type);
    if (typeCmp !== 0) {
      return typeCmp;
    }
    return a.sortOrder - b.sortOrder;
  });
}

/** Exported for tests — detect loose duplicate keys between MAL and AniPlaylist. */
export function malAniKeysMatch(malKey: string, aniKey: string): boolean {
  const [malType, malTitle, malArtist] = malKey.split('\0');
  const [aniType, aniTitle, aniArtist] = aniKey.split('\0');
  if (malType !== aniType) {
    return false;
  }
  if (!titlesRoughlyMatch(malTitle, aniTitle)) {
    return false;
  }
  if (!malArtist) {
    return true;
  }
  return titlesRoughlyMatch(malArtist, aniArtist);
}

export { parseSpotifyTrackIdFromUrl };
