import type { AniplaylistHit } from './aniplaylistApi';
import { isAniplaylistThemeType, normalizeAniplaylistThemeType } from './aniplaylistApi';
import type { ParsedMalTheme } from './malThemeParser';
import {
  artistsRoughlyMatch,
  artistsRoughlyMatchAny as hitArtistsMatchMalArtist,
  collectTitleMatchCandidates,
  malThemeMatchesAniplaylistHit,
  titlesMatchStronglyAny,
  titlesRoughlyMatch,
  titlesRoughlyMatchAny,
} from './themeSongMatching';
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

export { artistsRoughlyMatch, titlesRoughlyMatch } from './themeSongMatching';

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
    const opEd = parseOpEdAniplaylistSongKey(key, 'OP');
    if (opEd) {
      return opEd;
    }
    if (/^TS$/i.test(key)) {
      return { sortOrder: 0, badge: 'OP', episodeLine: null };
    }
    return { sortOrder: null, badge: null, episodeLine: null };
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

function themeSongEpisodeLineForSort(row: MediaThemeSongRow): string | null {
  if (row.songKey?.trim()) {
    const parsed = parseAniplaylistSongKey(row.songKey, row.type);
    if (parsed.episodeLine) {
      return parsed.episodeLine;
    }
  }
  return row.malEpisodes ?? null;
}

/** Episode numbers parsed from theme episode text for within-type sorting. */
export function parseThemeSongEpisodeNumbers(episodeLine: string | null): number[] {
  if (!episodeLine?.trim()) {
    return [];
  }
  const nums: number[] = [];
  const re = /\d+/g;
  let match: RegExpExecArray | null = re.exec(episodeLine);
  while (match) {
    const n = Number(match[0]);
    if (Number.isFinite(n)) {
      nums.push(n);
    }
    match = re.exec(episodeLine);
  }
  return nums;
}

export function themeSongMinEpisode(row: MediaThemeSongRow): number {
  const nums = parseThemeSongEpisodeNumbers(themeSongEpisodeLineForSort(row));
  if (nums.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.min(...nums);
}

/** Sort within one OP/ED/IN bucket: appearance index, then earliest episode. */
export function compareThemeSongRowsWithinType(
  a: MediaThemeSongRow,
  b: MediaThemeSongRow,
): number {
  const orderCmp = a.sortOrder - b.sortOrder;
  if (orderCmp !== 0) {
    return orderCmp;
  }
  const epCmp = themeSongMinEpisode(a) - themeSongMinEpisode(b);
  if (epCmp !== 0) {
    return epCmp;
  }
  const titleA = a.displayTitle?.trim() ?? '';
  const titleB = b.displayTitle?.trim() ?? '';
  return titleA.localeCompare(titleB, undefined, { sensitivity: 'base' });
}

export function compareThemeSongRows(a: MediaThemeSongRow, b: MediaThemeSongRow): number {
  const typeCmp =
    THEME_SONG_TYPE_ORDER.indexOf(a.type) - THEME_SONG_TYPE_ORDER.indexOf(b.type);
  if (typeCmp !== 0) {
    return typeCmp;
  }
  return compareThemeSongRowsWithinType(a, b);
}

export function sortThemeSongRows(rows: readonly MediaThemeSongRow[]): MediaThemeSongRow[] {
  return [...rows].sort(compareThemeSongRows);
}

function resolveOrphanAniplaylistSortOrder(hit: AniplaylistHit, orphanIndex: number): number {
  const type = normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ?? 'Opening';
  const fromKey = parseAniplaylistSongKey(hit.song_key, type).sortOrder;
  return fromKey ?? orphanIndex;
}

/**
 * Rank MAL ↔ AniPlaylist candidates when several hits share a title (rotating EDs).
 * Episode overlap and performer/CV beat first-hit-wins on title alone.
 */
export function scoreMalAniplaylistMatch(mal: ParsedMalTheme, hit: AniplaylistHit): number {
  if (!malThemeMatchesAniplaylistHit(mal, hit)) {
    return -1;
  }

  let score = 0;
  const malTitleVariants = collectTitleMatchCandidates(mal.title);
  if (titlesMatchStronglyAny(hit.titles, malTitleVariants)) {
    score += 1;
  }

  if (mal.artist && hitArtistsMatchMalArtist(hit.artists ?? [], mal.artist)) {
    score += 100;
  }

  const malEps = parseThemeSongEpisodeNumbers(mal.episodes ?? null);
  if (malEps.length > 0) {
    const aniType = normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ?? mal.type;
    const aniEpLine = parseAniplaylistSongKey(hit.song_key, aniType).episodeLine;
    const aniEps = parseThemeSongEpisodeNumbers(aniEpLine);
    if (aniEps.length > 0) {
      const overlap = malEps.filter((ep) => aniEps.includes(ep)).length;
      if (overlap === 0) {
        return -1;
      }
      score += 50 + overlap * 10;
    }
  }

  return score;
}

function hitToPartialRow(hit: AniplaylistHit, sortOrder: number): MediaThemeSongRow {
  const type = normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ?? 'Opening';
  const spotifyUrl = pickSpotifyLink(hit.links ?? []);
  const trackIds = collectSpotifyTrackIds(hit.links ?? [], hit.other_link_ids, spotifyUrl);
  const primaryTitle = hit.titles[0] ?? hit.song_key;
  const artist = hit.artists?.[0]?.names?.[0] ?? null;
  const resolvedUrl =
    spotifyUrl ??
    buildSpotifySearchUrl(primaryTitle, artist);

  return {
    type,
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
  const themeHits = aniHits.filter((h) => isAniplaylistThemeType(h.song_type, h.song_key));
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
    let bestScore = -1;
    for (const hit of themeHits) {
      if (matchedAni.has(hit.id)) {
        continue;
      }
      const score = scoreMalAniplaylistMatch(mal, hit);
      if (score > bestScore) {
        bestScore = score;
        bestHit = hit;
      }
    }
    if (bestHit && bestScore >= 0) {
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
    const type = normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ?? 'Opening';
    const orphanIndex = orphanIndexByType[type];
    orphanIndexByType[type] += 1;
    rows.push(hitToPartialRow(hit, resolveOrphanAniplaylistSortOrder(hit, orphanIndex)));
  });

  rows.sort(compareThemeSongRows);

  return borrowSharedSpotifyMetadata(rows);
}

function themeSongTitleVariants(row: MediaThemeSongRow): string[] {
  const variants = new Set<string>();
  for (const title of [row.malTitle, row.displayTitle, ...(row.aniTitles ?? [])]) {
    if (!title?.trim()) {
      continue;
    }
    for (const candidate of collectTitleMatchCandidates(title)) {
      variants.add(candidate);
    }
  }
  return [...variants];
}

function themeSongArtistCandidates(row: MediaThemeSongRow): string[] {
  const names = new Set<string>();
  for (const candidate of [row.malArtist, row.displayArtist, ...(row.aniArtists ?? [])]) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      names.add(trimmed);
    }
  }
  return [...names];
}

function artistsRoughlyMatchAny(left: readonly string[], right: readonly string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (artistsRoughlyMatch(a, b)) {
        return true;
      }
    }
  }
  return false;
}

/** Same recording within a show — ignores OP/ED role. */
export function rowsShareSongIdentity(a: MediaThemeSongRow, b: MediaThemeSongRow): boolean {
  const titlesA = themeSongTitleVariants(a);
  const titlesB = themeSongTitleVariants(b);
  if (titlesA.length === 0 || titlesB.length === 0) {
    return false;
  }
  const strongTitleMatch = titlesMatchStronglyAny(titlesA, titlesB);
  if (!strongTitleMatch && !titlesRoughlyMatchAny(titlesA, titlesB)) {
    return false;
  }

  const artistsA = themeSongArtistCandidates(a);
  const artistsB = themeSongArtistCandidates(b);
  if (artistsA.length === 0 || artistsB.length === 0) {
    // Only skip artist when we cannot compare — and only on an exact title match.
    return strongTitleMatch;
  }
  return artistsRoughlyMatchAny(artistsA, artistsB);
}

/**
 * Rows that missed AniPlaylist pairing (e.g. MAL ED ep-1 OP pollution) still share
 * the same Spotify track when title+artist identify the same recording.
 */
export function borrowSharedSpotifyMetadata(rows: MediaThemeSongRow[]): MediaThemeSongRow[] {
  const donors = rows.filter(
    (row) => row.spotifyTrackIds.length > 0 || row.spotifyIsrc !== null,
  );
  if (donors.length === 0) {
    return rows;
  }
  return rows.map((row) => {
    if (row.spotifyTrackIds.length > 0) {
      return row;
    }
    const donor = donors.find((candidate) => rowsShareSongIdentity(row, candidate));
    if (!donor) {
      return row;
    }
    return {
      ...row,
      spotifyUrl: donor.spotifyUrl ?? row.spotifyUrl,
      spotifyTrackIds: [...donor.spotifyTrackIds],
      spotifyIsrc: donor.spotifyIsrc ?? row.spotifyIsrc,
      hasResolvableTrackId: donor.spotifyTrackIds.length > 0,
    };
  });
}

export function sortThemeRows(rows: readonly MediaThemeSongRow[]): MediaThemeSongRow[] {
  return sortThemeSongRows(rows);
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
