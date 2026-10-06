import type { ThemeSongType } from './types';

export const ANISONGDB_SEARCH_ENDPOINT = 'https://anisongdb.com/api/search_request';
export const ANISONGDB_LOCAL_PROXY_PATH = '/api/anisongdb/search';

/** Default AMQ dist server (matches anisongdb.com default). */
export const ANISONGDB_DIST_BASE_URL = 'https://naedist.animemusicquiz.com/';

const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};

export type AnisongdbLinkedIds = {
  myanimelist?: number | null;
  anidb?: number | null;
  anilist?: number | null;
  kitsu?: number | null;
};

export type AnisongdbSearchHit = {
  annId: number;
  annSongId: number;
  amqSongId?: number;
  animeENName: string;
  animeJPName: string;
  animeAltName?: string[];
  songType: string;
  songName: string;
  songArtist: string;
  HQ: string | null;
  MQ: string | null;
  audio: string | null;
  linked_ids: AnisongdbLinkedIds;
};

export type AnisongdbPlayableSource = {
  videoUrl: string | null;
  audioUrl: string | null;
  annSongId: number;
};

/** English song title only — artist, anime, and song type are matched locally. */
export type AnisongdbSearchContext = {
  songTitle: string;
  themeType: ThemeSongType;
};

export function resolveAnisongdbSearchUrl(): string {
  const configured = ENV.VITE_ANISONGDB_PROXY_URL?.trim();
  if (configured) {
    return configured;
  }
  if (ENV.DEV) {
    return ANISONGDB_LOCAL_PROXY_PATH;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return ANISONGDB_LOCAL_PROXY_PATH;
    }
  }
  return ANISONGDB_SEARCH_ENDPOINT;
}

/**
 * AnisongDB song names are stored in English/Roman letters — search by title only.
 * Narrow results locally: anime → artist → OP/ED/IN slot.
 */
export function buildAnisongdbSearchBody(songTitle: string): Record<string, unknown> {
  const title = songTitle.trim();
  const body: Record<string, unknown> = {
    ignore_duplicate: false,
  };
  if (title) {
    body.song_name_search_filter = { search: title, partial_match: true };
  }
  return body;
}

export function buildAnisongdbMediaUrl(
  filename: string | null | undefined,
  baseUrl = ANISONGDB_DIST_BASE_URL,
): string | null {
  const trimmed = filename?.trim();
  if (!trimmed) {
    return null;
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${trimmed}`;
}

export function pickPlayableSource(hit: AnisongdbSearchHit): AnisongdbPlayableSource {
  return {
    annSongId: hit.annSongId,
    videoUrl: buildAnisongdbMediaUrl(hit.HQ ?? hit.MQ),
    audioUrl: buildAnisongdbMediaUrl(hit.audio),
  };
}

export function hitHasPlayableMedia(hit: AnisongdbSearchHit): boolean {
  const source = pickPlayableSource(hit);
  return source.videoUrl !== null || source.audioUrl !== null;
}

function buildAnisongdbRequestHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Client-Id': 'AnisongDB',
  };
}

export async function searchAnisongdb(songTitle: string): Promise<AnisongdbSearchHit[]> {
  const url = resolveAnisongdbSearchUrl();
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAnisongdbRequestHeaders(),
    body: JSON.stringify(buildAnisongdbSearchBody(songTitle)),
  });
  if (!res.ok) {
    throw new Error(`AnisongDB search failed (${res.status})`);
  }
  const data = (await res.json()) as AnisongdbSearchHit[] | unknown;
  if (!Array.isArray(data)) {
    return [];
  }
  return data as AnisongdbSearchHit[];
}
