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

function packThemes(openings: string[], endings: string[]): JikanThemesFetchResult {
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

export async function fetchJikanThemes(malId: number): Promise<JikanThemesFetchResult> {
  const themesUrl = `${JIKAN_BASE}/anime/${malId}/themes`;
  const themesRes = await fetchJson<JikanThemesResponse>(themesUrl);

  if (themesRes.status === 504 || themesRes.status === 502 || themesRes.status === 503) {
    const full = await fetchJikanThemesFromFull(malId);
    return {
      ...full,
      themesHttpStatus: themesRes.status,
    };
  }

  if (themesRes.body?.data) {
    const result = packThemes(
      themesRes.body.data.openings ?? [],
      themesRes.body.data.endings ?? [],
    );
    return { ...result, themesHttpStatus: themesRes.status };
  }

  if (themesRes.status >= 400) {
    const full = await fetchJikanThemesFromFull(malId);
    return {
      ...full,
      themesHttpStatus: themesRes.status,
    };
  }

  return {
    data: { openings: [], endings: [] },
    status: 'empty',
    themesHttpStatus: themesRes.status,
  };
}

async function fetchJikanThemesFromFull(malId: number): Promise<JikanThemesFetchResult> {
  const fullUrl = `${JIKAN_BASE}/anime/${malId}/full`;
  const fullRes = await fetchJson<JikanFullResponse>(fullUrl);
  if (!fullRes.body?.data?.theme) {
    return {
      data: null,
      status: 'failed',
      fullHttpStatus: fullRes.status,
    };
  }
  const theme = fullRes.body.data.theme;
  const result = packThemes(theme.openings ?? [], theme.endings ?? []);
  return {
    ...result,
    fullHttpStatus: fullRes.status,
    status: result.status === 'empty' ? 'empty' : result.status,
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
  return parts.length > 0 ? parts.join(', ') : 'unavailable';
}
