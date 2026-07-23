import type { JikanThemesData, JikanThemesFetchResult } from './jikanApi';

const MAL_API_DIRECT_BASE = 'https://api.myanimelist.net';

/** Same-origin Vite dev/preview proxy — see vite.config.ts */
export const MAL_LOCAL_PROXY_PATH = '/api/mal';

function malEnv(): Record<string, string | undefined> {
  return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
}

function malClientId(): string {
  return malEnv().VITE_MAL_CLIENT_ID ?? '';
}

type MalThemeEntry = {
  text?: string;
};

type MalAnimeThemesResponse = {
  opening_themes?: MalThemeEntry[];
  ending_themes?: MalThemeEntry[];
};

/**
 * MAL's API does not send CORS headers, so browsers cannot call it directly
 * (unlike Jikan). Use the Vite proxy locally or `VITE_MAL_PROXY_URL` in prod.
 */
export function resolveMalApiBaseUrl(): string {
  const env = malEnv();
  const configured = env.VITE_MAL_PROXY_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (env.DEV) {
    return MAL_LOCAL_PROXY_PATH;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return MAL_LOCAL_PROXY_PATH;
    }
  }
  return MAL_API_DIRECT_BASE;
}

/** Cloudflare worker URL — cross-origin; omit client id header (worker adds it). */
export function isMalRemoteProxyUrl(baseUrl: string): boolean {
  return baseUrl !== MAL_LOCAL_PROXY_PATH && baseUrl !== MAL_API_DIRECT_BASE;
}

export function isMalOfficialApiConfigured(): boolean {
  const env = malEnv();
  return Boolean(env.VITE_MAL_PROXY_URL?.trim() || malClientId().length > 0);
}

/** Normalize official MAL API theme lines to Jikan-style strings for `parseMalThemes`. */
export function normalizeMalOfficialThemeLine(text: string): string {
  return text.trim().replace(/^#(\d+)\s*:\s*/, '$1: ');
}

function packMalThemes(openings: string[], endings: string[]): JikanThemesFetchResult {
  if (openings.length === 0 && endings.length === 0) {
    return {
      data: { openings, endings },
      status: 'empty',
    };
  }
  return {
    data: { openings, endings },
    status: 'ok',
  };
}

function themeLines(entries: MalThemeEntry[] | undefined): string[] {
  if (!entries) {
    return [];
  }
  return entries
    .map((entry) => entry.text?.trim())
    .filter((line): line is string => Boolean(line))
    .map(normalizeMalOfficialThemeLine);
}

function buildMalRequestHeaders(baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  // Local/remote proxies inject X-MAL-CLIENT-ID server-side.
  const clientId = malClientId();
  if (baseUrl === MAL_API_DIRECT_BASE && clientId.length > 0) {
    headers['X-MAL-CLIENT-ID'] = clientId;
  }
  return headers;
}

/** Official MyAnimeList API themes (`opening_themes` / `ending_themes` fields). */
export async function fetchMalOfficialThemes(malId: number): Promise<JikanThemesFetchResult> {
  if (!isMalOfficialApiConfigured()) {
    return { data: null, status: 'failed' };
  }

  const baseUrl = resolveMalApiBaseUrl();
  const url = `${baseUrl}/v2/anime/${malId}?fields=opening_themes,ending_themes`;
  const res = await fetch(url, { headers: buildMalRequestHeaders(baseUrl) });
  if (!res.ok) {
    return {
      data: null,
      status: 'failed',
      malHttpStatus: res.status,
    };
  }

  const body = (await res.json()) as MalAnimeThemesResponse;
  const openings = themeLines(body.opening_themes);
  const endings = themeLines(body.ending_themes);
  const packed = packMalThemes(openings, endings);
  return {
    ...packed,
    malHttpStatus: res.status,
  };
}

export type MalOfficialThemesData = JikanThemesData;
