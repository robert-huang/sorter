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

const THEME_SONG_TYPES = new Set(['Opening', 'Ending', 'Insert']);

export class AniplaylistSearchError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message?: string) {
    super(message ?? `AniPlaylist search failed (${httpStatus})`);
    this.name = 'AniplaylistSearchError';
    this.httpStatus = httpStatus;
  }
}

export function isAniplaylistThemeType(songType: string): boolean {
  return THEME_SONG_TYPES.has(songType);
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
    if (!isAniplaylistThemeType(hit.song_type)) {
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

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(hitTitles: readonly string[], malTitle: string): boolean {
  const malNorm = normalizeForMatch(malTitle);
  if (!malNorm) {
    return false;
  }
  return hitTitles.some((t) => {
    const hitNorm = normalizeForMatch(t);
    return hitNorm === malNorm || hitNorm.includes(malNorm) || malNorm.includes(hitNorm);
  });
}

function artistMatches(hitArtists: readonly AniplaylistArtist[], malArtist: string | null): boolean {
  if (!malArtist) {
    return true;
  }
  const malNorm = normalizeForMatch(malArtist);
  for (const artist of hitArtists) {
    for (const name of artist.names ?? []) {
      const n = normalizeForMatch(name);
      if (n.includes(malNorm) || malNorm.includes(n)) {
        return true;
      }
    }
  }
  return false;
}

function typeMatches(hitType: string, malType: string): boolean {
  return hitType === malType;
}

export function findMatchingAnimeCluster(
  clusters: Map<number, AniplaylistHit[]>,
  malThemes: ReadonlyArray<{ type: string; title: string; artist: string | null }>,
): AniplaylistHit[] | null {
  const ranked = [...clusters.entries()].sort(
    (a, b) => maxScoreForAnimeCluster(b[1]) - maxScoreForAnimeCluster(a[1]),
  );

  for (const [, hits] of ranked) {
    for (const hit of hits) {
      for (const mal of malThemes) {
        if (
          typeMatches(hit.song_type, mal.type) &&
          titleMatches(hit.titles, mal.title) &&
          artistMatches(hit.artists ?? [], mal.artist)
        ) {
          return hits;
        }
      }
    }
  }

  if (ranked.length > 0) {
    return ranked[0][1];
  }
  return null;
}
