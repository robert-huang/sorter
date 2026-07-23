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
    return japan.link;
  }
  const main = spotify.find((l) => l.main);
  if (main?.link) {
    return main.link;
  }
  return spotify[0]?.link ?? null;
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

export function buildSpotifySearchUrl(title: string, artist: string | null): string {
  const q = artist ? `${title} ${artist}` : title;
  return `https://open.spotify.com/search/${encodeURIComponent(q)}`;
}
