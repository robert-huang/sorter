import { malThemeMatchesAniplaylistHit } from './themeSongMatching';
import type { ThemeSongType } from './types';

export const ANIPLAYLIST_ALGOLIA_APP_ID = 'P4B7HT5P18';
export const ANIPLAYLIST_ALGOLIA_API_KEY = 'cd90c9c918df8b42327310ade1f599bd';
export const ANIPLAYLIST_ALGOLIA_INDEX = 'songs_prod';
export const ANIPLAYLIST_HITS_PER_PAGE = 16;
export const ANIPLAYLIST_ORIGIN = 'https://aniplaylist.com';

/** Same-origin Vite dev/preview proxy — see vite.config.ts */
export const ANIPLAYLIST_LOCAL_PROXY_PATH = '/api/aniplaylist/algolia';

const DIRECT_ALGOLIA_URL = `https://${ANIPLAYLIST_ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;
const USER_TOKEN_STORAGE_KEY = 'aniplaylist:algolia-user-token';

const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};

/**
 * Algolia only accepts aniplaylist.com as Origin/Referer. Browsers always send
 * the real page origin on fetch, so local/GH Pages direct calls get 403.
 * Use the Vite proxy (dev/preview on localhost) or `VITE_ANIPLAYLIST_PROXY_URL`.
 */
export function resolveAniplaylistSearchUrl(): string {
  const configured = ENV.VITE_ANIPLAYLIST_PROXY_URL?.trim();
  if (configured) {
    return configured;
  }
  if (ENV.DEV) {
    return ANIPLAYLIST_LOCAL_PROXY_PATH;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      // `vite preview` runs with mode production but still serves the dev proxy.
      return ANIPLAYLIST_LOCAL_PROXY_PATH;
    }
  }
  return DIRECT_ALGOLIA_URL;
}

/** Cloudflare worker URL — cross-origin; omit client Algolia headers (worker adds them). */
export function isAniplaylistRemoteProxyUrl(url: string): boolean {
  return url !== ANIPLAYLIST_LOCAL_PROXY_PATH && url !== DIRECT_ALGOLIA_URL;
}

function buildAniplaylistRequestHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Content-Type': 'application/json',
  };
  if (!isAniplaylistRemoteProxyUrl(url)) {
    headers['x-algolia-application-id'] = ANIPLAYLIST_ALGOLIA_APP_ID;
    headers['x-algolia-api-key'] = ANIPLAYLIST_ALGOLIA_API_KEY;
  }
  return headers;
}

export type AniplaylistArtist = {
  names?: string[];
};

export type AniplaylistHit = {
  id: number;
  anime_id: number;
  score: number;
  titles: string[];
  song_key: string;
  song_type: string;
  song_type_short?: string;
  artists?: AniplaylistArtist[];
  links?: Array<{
    platform?: string;
    main?: boolean;
    link?: string;
    detail?: string;
  }>;
  other_link_ids?: string[];
  short_link?: string;
  anime_titles?: string[];
};

type AlgoliaResponse = {
  results?: Array<{
    hits?: AniplaylistHit[];
    nbHits?: number;
  }>;
};

const THEME_SONG_TYPES = new Set<ThemeSongType>(['Opening', 'Ending', 'Insert']);

/**
 * AniPlaylist uses `Theme Song` / `song_key: TS` for movie themes that MAL lists as openings.
 */
export function normalizeAniplaylistThemeType(
  songType: string,
  songKey?: string,
): ThemeSongType | null {
  if (THEME_SONG_TYPES.has(songType as ThemeSongType)) {
    return songType as ThemeSongType;
  }
  if (songType === 'Theme Song' || songKey?.trim().toUpperCase() === 'TS') {
    return 'Opening';
  }
  return null;
}

export class AniplaylistSearchError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message?: string) {
    super(message ?? `AniPlaylist search failed (${httpStatus})`);
    this.name = 'AniplaylistSearchError';
    this.httpStatus = httpStatus;
  }
}

export function isAniplaylistThemeType(songType: string, songKey?: string): boolean {
  return normalizeAniplaylistThemeType(songType, songKey) !== null;
}

function getAniplaylistUserToken(): string {
  if (typeof sessionStorage === 'undefined') {
    return `anonymous-${Date.now()}`;
  }
  try {
    const existing = sessionStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const token = `anonymous-${crypto.randomUUID()}`;
    sessionStorage.setItem(USER_TOKEN_STORAGE_KEY, token);
    return token;
  } catch {
    return `anonymous-${Date.now()}`;
  }
}

/** Build Algolia params to match aniplaylist.com's InstantSearch requests. */
export function buildAniplaylistSearchParams(query: string, page: number): string {
  const params = new URLSearchParams();
  params.set('analytics', 'true');
  params.set('clickAnalytics', 'true');
  params.set('distinct', 'true');
  params.set('enablePersonalization', 'false');
  params.set(
    'facets',
    JSON.stringify([
      'links.label',
      'links.link_markets',
      'platforms',
      'season',
      'song_type',
      'status',
    ]),
  );
  params.set('highlightPostTag', '__/ais-highlight__');
  params.set('highlightPreTag', '__ais-highlight__');
  params.set('hitsPerPage', String(ANIPLAYLIST_HITS_PER_PAGE));
  params.set('maxValuesPerFacet', '250');
  params.set('page', String(page));
  params.set('query', query);
  params.set('userToken', getAniplaylistUserToken());
  return params.toString();
}

export async function searchAniplaylist(query: string): Promise<AniplaylistHit[]> {
  const allHits: AniplaylistHit[] = [];
  let page = 0;

  while (true) {
    const body = {
      requests: [
        {
          indexName: ANIPLAYLIST_ALGOLIA_INDEX,
          params: buildAniplaylistSearchParams(query, page),
        },
      ],
    };

    const searchUrl = resolveAniplaylistSearchUrl();
    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: buildAniplaylistRequestHeaders(searchUrl),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new AniplaylistSearchError(res.status);
    }

    const json = (await res.json()) as AlgoliaResponse;
    const hits = json.results?.[0]?.hits ?? [];
    allHits.push(...hits);

    if (hits.length < ANIPLAYLIST_HITS_PER_PAGE) {
      break;
    }
    page += 1;
  }

  return allHits;
}

export function groupHitsByAnimeId(hits: readonly AniplaylistHit[]): Map<number, AniplaylistHit[]> {
  const map = new Map<number, AniplaylistHit[]>();
  for (const hit of hits) {
    if (!isAniplaylistThemeType(hit.song_type, hit.song_key)) {
      continue;
    }
    const list = map.get(hit.anime_id) ?? [];
    list.push(hit);
    map.set(hit.anime_id, list);
  }
  return map;
}

export function maxScoreForAnimeCluster(hits: readonly AniplaylistHit[]): number {
  let max = 0;
  for (const hit of hits) {
    if (hit.score > max) {
      max = hit.score;
    }
  }
  return max;
}

export type MediaTitleCandidates = {
  english: string | null;
  romaji: string | null;
  native: string | null;
};

const ROMAN_SEASON: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toHalfwidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/** Strip season/part suffixes so franchise titles can be compared. */
export function stripSeasonFromTitle(title: string): string {
  let s = title.trim();
  s = s.replace(/\s*(?:season|series)\s*(?:\d+|[ivx]+)\b.*$/i, '');
  s = s.replace(/\s+\d+(?:st|nd|rd|th)?\s*season\b.*$/i, '');
  s = s.replace(/\s*(?:part|cour)\s*\d+\b.*$/i, '');
  s = s.replace(/\s+(\d+|[０-９]+)\s*$/i, '');
  return s.trim();
}

/** Parse a season/cour/part number from an anime title, if present. */
export function extractSeasonNumber(title: string): number | null {
  const norm = title.toLowerCase();

  let m = norm.match(/\b(?:season|series)\s*(\d+)\b/);
  if (m) {
    return Number.parseInt(m[1], 10);
  }

  m = norm.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  if (m) {
    return Number.parseInt(m[1], 10);
  }

  m = norm.match(/\b(?:part|cour)\s*(\d+)\b/);
  if (m) {
    return Number.parseInt(m[1], 10);
  }

  m = title.match(/(\d+|[０-９]+)\s*$/);
  if (m) {
    return Number.parseInt(toHalfwidthDigits(m[1]), 10);
  }

  m = norm.match(/\b(i{1,3}|iv|vi{0,3}|ix|x)\s*$/);
  if (m) {
    return ROMAN_SEASON[m[1]] ?? null;
  }

  return null;
}

export function collectMediaTitleStrings(candidates: MediaTitleCandidates): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [candidates.english, candidates.romaji, candidates.native]) {
    const trimmed = t?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function clusterAnimeTitles(hits: readonly AniplaylistHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    for (const t of hit.anime_titles ?? []) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/** Higher scores mean a stronger media-title ↔ cluster match. */
export function scoreMediaToAnimeTitle(mediaTitle: string, animeTitle: string): number {
  const mediaNorm = normalizeForMatch(mediaTitle);
  const animeNorm = normalizeForMatch(animeTitle);
  if (!mediaNorm || !animeNorm) {
    return 0;
  }
  if (mediaNorm === animeNorm) {
    return 100;
  }

  const mediaSeason = extractSeasonNumber(mediaTitle);
  const animeSeason = extractSeasonNumber(animeTitle);
  const mediaBase = normalizeForMatch(stripSeasonFromTitle(mediaTitle));
  const animeBase = normalizeForMatch(stripSeasonFromTitle(animeTitle));

  const basesMatch =
    mediaBase.length > 0 &&
    (mediaBase === animeBase || mediaBase.includes(animeBase) || animeBase.includes(mediaBase));

  if (basesMatch) {
    if (mediaSeason !== null && animeSeason !== null) {
      return mediaSeason === animeSeason ? 95 : 0;
    }
    if (mediaSeason !== null || animeSeason !== null) {
      return 35;
    }
    return 50;
  }

  if (mediaNorm.includes(animeNorm) || animeNorm.includes(mediaNorm)) {
    if (mediaSeason !== null && animeSeason !== null && mediaSeason !== animeSeason) {
      return 0;
    }
    return 40;
  }

  return 0;
}

export function scoreClusterForMediaTitles(
  hits: readonly AniplaylistHit[],
  mediaTitles: readonly string[],
): number {
  const animeTitles = clusterAnimeTitles(hits);
  if (animeTitles.length === 0 || mediaTitles.length === 0) {
    return 0;
  }
  let best = 0;
  for (const mediaTitle of mediaTitles) {
    for (const animeTitle of animeTitles) {
      best = Math.max(best, scoreMediaToAnimeTitle(mediaTitle, animeTitle));
    }
  }
  return best;
}

/**
 * Minimum `scoreMediaToAnimeTitle` for accepting an AniPlaylist cluster.
 * Matches the weakest intentional tier in that scorer: same franchise base with
 * no season on either side (50). Rejects substring-only matches (40) and
 * one-sided season hints (35). Algolia hit scores are unrelated.
 */
const TITLE_MATCH_THRESHOLD = 50;

function countMalThemeOverlaps(
  hits: readonly AniplaylistHit[],
  malThemes: ReadonlyArray<{ type: string; title: string; artist: string | null }>,
): number {
  let matches = 0;
  for (const hit of hits) {
    for (const mal of malThemes) {
      if (malThemeMatchesAniplaylistHit(mal, hit)) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

function findClusterWithMalOverlap(
  clusterList: readonly AniplaylistHit[][],
  malThemes: ReadonlyArray<{ type: string; title: string; artist: string | null }>,
): AniplaylistHit[] | null {
  if (malThemes.length === 0) {
    return null;
  }

  let best: { hits: AniplaylistHit[]; count: number } | null = null;
  for (const hits of clusterList) {
    const count = countMalThemeOverlaps(hits, malThemes);
    if (count > 0 && (!best || count > best.count)) {
      best = { hits: [...hits], count };
    }
  }
  return best?.hits ?? null;
}

function pickBestTitleCluster(
  titleCandidates: Array<{ hits: AniplaylistHit[]; titleScore: number; algoliaScore: number }>,
  malThemes: ReadonlyArray<{ type: string; title: string; artist: string | null }>,
): AniplaylistHit[] | null {
  if (titleCandidates.length === 0) {
    return null;
  }

  const malMatch = findClusterWithMalOverlap(
    titleCandidates.map((c) => c.hits),
    malThemes,
  );
  if (malMatch) {
    return malMatch;
  }

  const topScore = titleCandidates[0].titleScore;
  const topTier = titleCandidates.filter((c) => c.titleScore === topScore);
  if (topTier.length === 1) {
    return topTier[0].hits;
  }

  return [...topTier].sort((a, b) => b.algoliaScore - a.algoliaScore)[0]?.hits ?? null;
}

/**
 * Pick one AniPlaylist `anime_id` cluster for the media being expanded.
 * Media titles are the primary signal — Algolia relevance must not override season.
 */
export function findMatchingAnimeCluster(
  clusters: Map<number, AniplaylistHit[]>,
  malThemes: ReadonlyArray<{ type: string; title: string; artist: string | null }>,
  mediaTitles: MediaTitleCandidates = { english: null, romaji: null, native: null },
): AniplaylistHit[] | null {
  if (clusters.size === 0) {
    return null;
  }

  const titleStrings = collectMediaTitleStrings(mediaTitles);
  const scored = [...clusters.values()].map((hits) => ({
    hits,
    titleScore: scoreClusterForMediaTitles(hits, titleStrings),
    algoliaScore: maxScoreForAnimeCluster(hits),
  }));

  const titleCandidates = scored
    .filter((c) => c.titleScore >= TITLE_MATCH_THRESHOLD)
    .sort((a, b) => b.titleScore - a.titleScore || b.algoliaScore - a.algoliaScore);

  const titlePick = pickBestTitleCluster(titleCandidates, malThemes);
  if (titlePick) {
    return titlePick;
  }

  const malOnly = findClusterWithMalOverlap([...clusters.values()], malThemes);
  if (malOnly) {
    return malOnly;
  }

  // Do not fall back to highest Algolia score when titles do not match.
  return null;
}
