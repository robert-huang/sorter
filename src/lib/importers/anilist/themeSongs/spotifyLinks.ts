export type AniplaylistLink = {
  platform?: string;
  main?: boolean;
  link?: string;
  detail?: string;
};

const SPOTIFY_TRACK_ID_RE = /^[0-9A-Za-z]{22}$/;

export function parseSpotifyTrackIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('spotify.com')) {
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

export function pickSpotifyLink(links: readonly AniplaylistLink[]): string | null {
  const spotify = links.filter((l) => l.platform?.toLowerCase() === 'spotify' && l.link);
  if (spotify.length === 0) {
    return null;
  }
  const japan = spotify.find((l) => l.detail === 'Japan link');
  if (japan?.link) {
    return normalizeSpotifySearchUrl(japan.link);
  }
  const main = spotify.find((l) => l.main);
  if (main?.link) {
    return normalizeSpotifySearchUrl(main.link);
  }
  const fallback = spotify[0]?.link ?? null;
  return fallback ? normalizeSpotifySearchUrl(fallback) : null;
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

/** Re-encode stored/external Spotify search URLs that have raw path characters. */
export function normalizeSpotifySearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('spotify.com')) {
      return url;
    }
    const match = parsed.pathname.match(/^\/search\/(.+)$/);
    if (!match?.[1]) {
      return url;
    }
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      /* keep raw segment */
    }
    const cleaned = decoded.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    return `https://open.spotify.com/search/${encodeSpotifySearchPathSegment(cleaned)}`;
  } catch {
    return url;
  }
}

export function buildSpotifySearchUrl(title: string, artist: string | null): string {
  const q = sanitizeSpotifySearchQuery(title, artist);
  return `https://open.spotify.com/search/${encodeSpotifySearchPathSegment(q)}`;
}
