export type AniplaylistLink = {
  platform?: string;
  main?: boolean;
  link?: string;
  detail?: string;
  link_markets?: string[];
};

export type PickedSpotifyLink = {
  url: string;
  availableMarkets: string[] | null;
};

const SPOTIFY_TRACK_ID_RE = /^[0-9A-Za-z]{22}$/;
const SPOTIFY_METADATA_QUERY_PARAMS = new Set([
  'si',
  'dlsi',
  'sp_cid',
  '_branch_match_id',
  '_branch_referrer',
]);

function isSpotifyHostname(hostname: string): boolean {
  return hostname === 'spotify.com' || hostname.endsWith('.spotify.com');
}

function isSpotifyMetadataQueryParam(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName.startsWith('utm_') || SPOTIFY_METADATA_QUERY_PARAMS.has(normalizedName)
  );
}

export function parseSpotifyTrackIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isSpotifyHostname(parsed.hostname)) {
      return null;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const trackIdx = parts.indexOf('track');
    if (trackIdx >= 0 && parts[trackIdx + 1]) {
      return parts[trackIdx + 1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export function looksLikeSpotifyTrackId(id: string): boolean {
  return SPOTIFY_TRACK_ID_RE.test(id);
}

function normalizeSpotifyMarkets(markets: readonly string[] | undefined): string[] | null {
  if (!markets) {
    return null;
  }
  return [...new Set(markets.map((market) => market.trim().toUpperCase()).filter(Boolean))];
}

function isJapanOnlySpotifyLink(link: AniplaylistLink): boolean {
  const markets = normalizeSpotifyMarkets(link.link_markets);
  return markets?.length === 1 && markets[0] === 'JP';
}

export function pickSpotifyLinkDetails(
  links: readonly AniplaylistLink[],
): PickedSpotifyLink | null {
  const spotify = links.filter((l) => l.platform?.toLowerCase() === 'spotify' && l.link);
  if (spotify.length === 0) {
    return null;
  }
  const picked =
    spotify.find((link) => link.detail === 'Japan link') ??
    spotify.find(isJapanOnlySpotifyLink) ??
    spotify.find((link) => link.main) ??
    spotify[0];
  return picked?.link
    ? {
        url: normalizeSpotifyUrl(picked.link),
        availableMarkets: normalizeSpotifyMarkets(picked.link_markets),
      }
    : null;
}

export function pickSpotifyLink(links: readonly AniplaylistLink[]): string | null {
  return pickSpotifyLinkDetails(links)?.url ?? null;
}

export function isSpotifyUnavailableInMarket(
  availableMarkets: readonly string[] | undefined,
  spotifyCountry: string | null | undefined,
): boolean {
  if (!availableMarkets || !spotifyCountry) {
    return false;
  }
  return !availableMarkets.includes(spotifyCountry.toUpperCase());
}

/** Theme-row track IDs plus any `/track/{id}` parsed from the display URL. */
export function mergeSpotifyTrackIdSources(
  trackIds: readonly string[],
  spotifyUrl: string | null | undefined,
): string[] {
  const ids = new Set(trackIds);
  if (spotifyUrl) {
    const fromUrl = parseSpotifyTrackIdFromUrl(spotifyUrl);
    if (fromUrl) {
      ids.add(fromUrl);
    }
  }
  return [...ids];
}

export function collectSpotifyTrackIds(
  links: readonly AniplaylistLink[],
  otherLinkIds: readonly string[] | undefined,
  chosenUrl: string | null,
): string[] {
  const ids = new Set<string>();
  if (chosenUrl) {
    const fromUrl = parseSpotifyTrackIdFromUrl(chosenUrl);
    if (fromUrl) {
      ids.add(fromUrl);
    }
  }
  for (const link of links) {
    if (link.platform?.toLowerCase() !== 'spotify' || !link.link) {
      continue;
    }
    const id = parseSpotifyTrackIdFromUrl(link.link);
    if (id) {
      ids.add(id);
    }
  }
  for (const raw of otherLinkIds ?? []) {
    if (looksLikeSpotifyTrackId(raw)) {
      ids.add(raw);
    }
  }
  return [...ids];
}

/**
 * `encodeURIComponent` leaves `( ) * '` unescaped. Spotify web search paths break on
 * raw parentheses — encode them explicitly for `/search/{query}` links.
 */
export function encodeSpotifySearchPathSegment(query: string): string {
  return encodeURIComponent(query).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Drop parenthetical tags (TV sizes, edit names) for cleaner Spotify text search. */
export function sanitizeSpotifySearchQuery(title: string, artist: string | null): string {
  const stripParens = (s: string): string =>
    s.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedTitle = stripParens(title.trim());
  if (!artist?.trim()) {
    return normalizedTitle;
  }
  return `${normalizedTitle} ${stripParens(artist.trim())}`.replace(/\s+/g, ' ').trim();
}

/** Canonicalize Spotify URLs while preserving parameters that affect link behavior. */
export function normalizeSpotifyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isSpotifyHostname(parsed.hostname)) {
      return url;
    }
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSpotifyMetadataQueryParam(name)) {
        parsed.searchParams.delete(name);
      }
    }
    const match = parsed.pathname.match(/^\/search\/(.+)$/);
    if (match?.[1]) {
      let decoded = match[1];
      try {
        decoded = decodeURIComponent(match[1]);
      } catch {
        /* keep raw segment */
      }
      const cleaned = decoded.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      parsed.pathname = `/search/${encodeSpotifySearchPathSegment(cleaned)}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function buildSpotifySearchUrl(title: string, artist: string | null): string {
  const q = sanitizeSpotifySearchQuery(title, artist);
  return `https://open.spotify.com/search/${encodeSpotifySearchPathSegment(q)}`;
}
