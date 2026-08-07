import { parseMalThemeString } from './malThemeParser';
import { foldJapaneseRomanization, normalizeThemeDashes } from './themeSongMatching';

const TENRAI_BASE = 'https://api.tenrai.org/v1';

export type TenraiThemesData = {
  openings: string[];
  endings: string[];
};

export type TenraiThemesFetchResult = {
  data: TenraiThemesData | null;
  /** `ok` = got a response; `empty` = responded but no themes; `failed` = both endpoints failed */
  status: 'ok' | 'empty' | 'failed';
  themesHttpStatus?: number;
  fullHttpStatus?: number;
  malHttpStatus?: number;
};

type TenraiThemesResponse = {
  data?: {
    openings?: string[];
    endings?: string[];
  };
};

type TenraiFullResponse = {
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

function episodeNumsFromMalEpisodes(episodes: string | null): string {
  if (!episodes?.trim()) {
    return '';
  }
  const nums: number[] = [];
  const re = /\d+/g;
  let match: RegExpExecArray | null = re.exec(episodes);
  while (match) {
    const n = Number(match[0]);
    if (Number.isFinite(n)) {
      nums.push(n);
    }
    match = re.exec(episodes);
  }
  return nums.join(',');
}

function themeStringDedupeKey(raw: string): string {
  const parsed = parseMalThemeString(raw, 'Opening', 0);
  const title = normalizeThemeDashes(
    foldJapaneseRomanization(parsed.title.toLowerCase()).replace(/[\u2018\u2019\u201b]/g, "'"),
  );
  const episodeKey = episodeNumsFromMalEpisodes(parsed.episodes);
  if (episodeKey) {
    // Same ED on the same episode with EN vs JP performer credits (Re:Zero Stay Alive).
    return `${title}|${episodeKey}`;
  }
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

export function unionTenraiThemesData(
  ...sources: readonly (TenraiThemesData | null | undefined)[]
): TenraiThemesData {
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
 * Fetch Tenrai's Jikan-compatible `/themes` and `/full` responses in parallel.
 * Either endpoint can supply themes the other missed.
 */
export async function fetchTenraiThemes(malId: number): Promise<TenraiThemesFetchResult> {
  const themesUrl = `${TENRAI_BASE}/anime/${malId}/themes`;
  const fullUrl = `${TENRAI_BASE}/anime/${malId}/full`;

  const [themesRes, fullRes] = await Promise.all([
    fetchJson<TenraiThemesResponse>(themesUrl),
    fetchJson<TenraiFullResponse>(fullUrl),
  ]);

  const themesData = themesRes.body?.data;
  const fullTheme = fullRes.body?.data?.theme;
  const merged = unionTenraiThemesData(
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

export function formatTenraiFailureDetail(result: TenraiThemesFetchResult): string {
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
