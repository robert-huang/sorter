import { parseMalThemeString } from './malThemeParser';
import { foldJapaneseRomanization } from './themeSongMatching';

const JIKAN_BASE = 'https://api.jikan.moe/v4';

export type JikanThemesData = {
  openings: string[];
  endings: string[];
};

export type JikanThemesFetchResult = {
  data: JikanThemesData | null;
  /** `ok` = got a response; `empty` = responded but no themes; `failed` = both endpoints failed */
  status: 'ok' | 'empty' | 'failed';
  themesHttpStatus?: number;
  fullHttpStatus?: number;
  malHttpStatus?: number;
};

type JikanThemesResponse = {
  data?: {
    openings?: string[];
    endings?: string[];
  };
};

type JikanFullResponse = {
  data?: {
    theme?: {
      openings?: string[];
      endings?: string[];
    };
  };
};

async function fetchJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    return { status: res.status, body: null };
  }
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

function themeStringDedupeKey(raw: string): string {
  const parsed = parseMalThemeString(raw, 'Opening', 0);
  const title = foldJapaneseRomanization(parsed.title.toLowerCase()).replace(
    /[\u2018\u2019\u201b]/g,
    "'",
  );
  const artist = foldJapaneseRomanization((parsed.artist ?? '').toLowerCase()).replace(
    /[\u2018\u2019\u201b]/g,
    "'",
  );
  return `${title}|${artist}`;
}

/** Union theme strings from multiple sources, deduping by parsed title + artist. */
export function dedupeThemeStrings(strings: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of strings) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const key = themeStringDedupeKey(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function unionJikanThemesData(
  ...sources: readonly (JikanThemesData | null | undefined)[]
): JikanThemesData {
  const openings: string[] = [];
  const endings: string[] = [];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    openings.push(...source.openings);
    endings.push(...source.endings);
  }
  return {
    openings: dedupeThemeStrings(openings),
    endings: dedupeThemeStrings(endings),
  };
}

function endpointReachable(status: number, hasPayload: boolean): boolean {
  return hasPayload || status < 400;
}

/**
 * Fetch Jikan `/themes` and `/full` in parallel and union openings/endings.
 * Either endpoint can supply themes the other missed (504 vs empty endings).
 */
export async function fetchJikanThemes(malId: number): Promise<JikanThemesFetchResult> {
  const themesUrl = `${JIKAN_BASE}/anime/${malId}/themes`;
  const fullUrl = `${JIKAN_BASE}/anime/${malId}/full`;

  const [themesRes, fullRes] = await Promise.all([
    fetchJson<JikanThemesResponse>(themesUrl),
    fetchJson<JikanFullResponse>(fullUrl),
  ]);

  const themesData = themesRes.body?.data;
  const fullTheme = fullRes.body?.data?.theme;
  const merged = unionJikanThemesData(
    themesData
      ? { openings: themesData.openings ?? [], endings: themesData.endings ?? [] }
      : null,
    fullTheme
      ? { openings: fullTheme.openings ?? [], endings: fullTheme.endings ?? [] }
      : null,
  );

  const themesReachable = endpointReachable(themesRes.status, themesData != null);
  const fullReachable = endpointReachable(fullRes.status, fullTheme != null);
  const base = {
    themesHttpStatus: themesRes.status,
    fullHttpStatus: fullRes.status,
  };

  if (merged.openings.length === 0 && merged.endings.length === 0) {
    if (!themesReachable && !fullReachable) {
      return {
        data: null,
        status: 'failed',
        ...base,
      };
    }
    return {
      data: merged,
      status: 'empty',
      ...base,
    };
  }

  return {
    data: merged,
    status: 'ok',
    ...base,
  };
}

export function formatJikanFailureDetail(result: JikanThemesFetchResult): string {
  const parts: string[] = [];
  if (result.themesHttpStatus !== undefined) {
    parts.push(`themes ${result.themesHttpStatus}`);
  }
  if (result.fullHttpStatus !== undefined) {
    parts.push(`full ${result.fullHttpStatus}`);
  }
  if (result.malHttpStatus !== undefined) {
    parts.push(`mal ${result.malHttpStatus}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'unavailable';
}
