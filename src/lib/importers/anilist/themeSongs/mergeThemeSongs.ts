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

const CV_CREDIT_RE = /\(CV:\s*([^)]+)\)/i;

function extractCvCredit(artist: string): string | null {
  const match = CV_CREDIT_RE.exec(artist);
  return match?.[1]?.trim() ?? null;
}

/** Drop parenthetical credits so token sets compare performer names only. */
function stripArtistParentheticals(artist: string): string {
  return artist
    .replace(/\(CV:[^)]*\)/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeArtistName(artist: string): Set<string> {
  const stripped = stripArtistParentheticals(artist).toLowerCase();
  const tokens = stripped.split(/[\s,]+/).filter((token) => token.length > 0);
  return new Set(tokens);
}

function artistTokenSetsMatch(a: string, b: string): boolean {
  const tokensA = tokenizeArtistName(a);
  const tokensB = tokenizeArtistName(b);
  if (tokensA.size === 0 || tokensB.size === 0 || tokensA.size !== tokensB.size) {
    return false;
  }
  for (const token of tokensA) {
    if (!tokensB.has(token)) {
      return false;
    }
  }
  return true;
}

/** Looser artist match: substring, CV credits, and token-set (word-order insensitive). */
export function artistsRoughlyMatch(a: string, b: string): boolean {
  if (titlesRoughlyMatch(a, b)) {
    return true;
  }
  const cvA = extractCvCredit(a);
  const cvB = extractCvCredit(b);
  if (cvA && cvB && titlesRoughlyMatch(cvA, cvB)) {
    return true;
  }
  if (artistTokenSetsMatch(a, b)) {
    return true;
  }
  if (cvA && artistTokenSetsMatch(cvA, b)) {
    return true;
  }
  if (cvB && artistTokenSetsMatch(cvB, a)) {
    return true;
  }
  return false;
}

/** Map AniPlaylist `song_key` (OP/ED/IN) to MAL-style zero-based sort order. */
export function sortOrderFromAniplaylistSongKey(
  songKey: string,
  type: ThemeSongType,
): number | null {
  return parseAniplaylistSongKey(songKey, type).sortOrder;
}

export type ParsedAniplaylistSongKey = {
  sortOrder: number | null;
  /** Badge label: OP, OP2, ED, ED6, IN, etc. */
  badge: string | null;
  /** Episode appearance text from trailing `song_key` suffix, e.g. `ep 1`. */
  episodeLine: string | null;
};

function episodeLineFromSongKeySuffix(suffix: string): string | null {
  const trimmed = suffix.trim();
  if (!trimmed) {
    return null;
  }
  const paren = /^\((.+)\)$/.exec(trimmed);
  const line = (paren?.[1] ?? trimmed).trim();
  return line.length > 0 ? line : null;
}

function parseOpEdAniplaylistSongKey(
  key: string,
  prefix: 'OP' | 'ED',
): ParsedAniplaylistSongKey | null {
  const match = new RegExp(`^${prefix}\\s*(\\d*)(.*)$`, 'i').exec(key);
  if (!match) {
    return null;
  }
  const num = match[1] === '' ? 1 : Number(match[1]);
  return {
    sortOrder: Number.isFinite(num) && num >= 1 ? num - 1 : null,
    badge: match[1] ? `${prefix}${match[1]}` : prefix,
    episodeLine: episodeLineFromSongKeySuffix(match[2] ?? ''),
  };
}

/**
 * Parse AniPlaylist `song_key` prefix (allows trailing episode text like `ED6 (ep 1)`).
 */
export function parseAniplaylistSongKey(
  songKey: string,
  type: ThemeSongType,
): ParsedAniplaylistSongKey {
  const key = songKey.trim();
  if (!key) {
    return { sortOrder: null, badge: null, episodeLine: null };
  }

  if (type === 'Opening') {
    return parseOpEdAniplaylistSongKey(key, 'OP') ?? { sortOrder: null, badge: null, episodeLine: null };
  }

  if (type === 'Ending') {
    return parseOpEdAniplaylistSongKey(key, 'ED') ?? { sortOrder: null, badge: null, episodeLine: null };
  }

  if (type === 'Insert') {
    const match = /^IN\s+(.+)$/i.exec(key);
    if (match) {
      const episodeLine = match[1].trim();
      const epNum = /^ep\s*(\d+)/i.exec(episodeLine);
      const ep = epNum ? Number(epNum[1]) : NaN;
      return {
        sortOrder: Number.isFinite(ep) ? ep - 1 : null,
        badge: 'IN',
        episodeLine: episodeLine.length > 0 ? episodeLine : null,
      };
    }
    return { sortOrder: null, badge: 'IN', episodeLine: null };
  }

  return { sortOrder: null, badge: null, episodeLine: null };
}

function resolveOrphanAniplaylistSortOrder(hit: AniplaylistHit, orphanIndex: number): number {
  const fromKey = parseAniplaylistSongKey(hit.song_key, hit.song_type as ThemeSongType).sortOrder;
  return fromKey ?? orphanIndex;
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
    (a.names ?? []).some((n) => artistsRoughlyMatch(n, mal.artist ?? '')),
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
  const orphanIndexByType: Record<ThemeSongType, number> = {
    Opening: 0,
    Ending: 0,
    Insert: 0,
  };

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

  themeHits.forEach((hit) => {
    if (matchedAni.has(hit.id)) {
      return;
    }
    const type = hit.song_type as ThemeSongType;
    const orphanIndex = orphanIndexByType[type];
    orphanIndexByType[type] += 1;
    rows.push(hitToPartialRow(hit, resolveOrphanAniplaylistSortOrder(hit, orphanIndex)));
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
  return artistsRoughlyMatch(malArtist, aniArtist);
}

export { parseSpotifyTrackIdFromUrl };
