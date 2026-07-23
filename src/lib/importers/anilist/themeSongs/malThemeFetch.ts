import {
  fetchJikanThemes,
  formatJikanFailureDetail,
  unionJikanThemesData,
  type JikanThemesData,
  type JikanThemesFetchResult,
} from './jikanApi';
import { fetchMalOfficialThemes, isMalOfficialApiConfigured } from './malOfficialApi';

export type MalThemeProvider = 'jikan' | 'mal-official';

export type MalThemeFetchResult = JikanThemesFetchResult & {
  provider?: MalThemeProvider;
};

export type MalThemeFetchHints = {
  /** Opening/Ending/Insert hits from the matched AniPlaylist cluster. */
  aniplaylistThemeCount?: number;
  aniplaylistEndingCount?: number;
};

function countThemes(data: JikanThemesData | null | undefined): number {
  if (!data) {
    return 0;
  }
  return data.openings.length + data.endings.length;
}

function isThinVersusAniplaylist(
  jikan: JikanThemesFetchResult,
  hints: MalThemeFetchHints,
): boolean {
  const total = countThemes(jikan.data);
  if (
    hints.aniplaylistThemeCount != null &&
    hints.aniplaylistThemeCount > 0 &&
    total < hints.aniplaylistThemeCount
  ) {
    return true;
  }
  if (
    hints.aniplaylistEndingCount != null &&
    hints.aniplaylistEndingCount > 0 &&
    (jikan.data?.endings.length ?? 0) === 0
  ) {
    return true;
  }
  return false;
}

function mergeOfficialIntoJikan(
  jikan: MalThemeFetchResult,
  official: JikanThemesFetchResult,
): MalThemeFetchResult {
  const merged = unionJikanThemesData(jikan.data, official.data);
  if (merged.openings.length === 0 && merged.endings.length === 0) {
    return {
      ...jikan,
      data: merged,
      status: jikan.status === 'failed' ? 'failed' : 'empty',
      malHttpStatus: official.malHttpStatus,
    };
  }
  return {
    ...jikan,
    data: merged,
    status: 'ok',
    malHttpStatus: official.malHttpStatus,
    provider: 'mal-official',
  };
}

async function fetchOfficialMalUnion(malId: number): Promise<MalThemeFetchResult> {
  const mal = await fetchMalOfficialThemes(malId);
  if (mal.status === 'failed') {
    return {
      ...mal,
      provider: 'mal-official',
    };
  }
  return {
    ...mal,
    provider: 'mal-official',
  };
}

/**
 * Jikan first (themes + full union), then official MyAnimeList API when Jikan fails
 * or when AniPlaylist suggests more themes than Jikan returned.
 */
export async function fetchMalThemeStrings(malId: number): Promise<MalThemeFetchResult> {
  const jikan = await fetchJikanThemes(malId);
  if (jikan.status !== 'failed') {
    return { ...jikan, provider: 'jikan' };
  }

  if (!isMalOfficialApiConfigured()) {
    return jikan;
  }

  const mal = await fetchOfficialMalUnion(malId);
  if (mal.status === 'failed') {
    return {
      ...jikan,
      malHttpStatus: mal.malHttpStatus,
      status: 'failed',
    };
  }

  return {
    ...mal,
    themesHttpStatus: jikan.themesHttpStatus,
    fullHttpStatus: jikan.fullHttpStatus,
  };
}

/**
 * After AniPlaylist search, retry official MAL when Jikan's union looks incomplete.
 */
export async function enrichMalThemesWithOfficialIfNeeded(
  jikan: MalThemeFetchResult,
  malId: number,
  hints: MalThemeFetchHints,
): Promise<MalThemeFetchResult> {
  if (!isMalOfficialApiConfigured()) {
    return jikan;
  }
  if (!isThinVersusAniplaylist(jikan, hints)) {
    return jikan;
  }

  const mal = await fetchOfficialMalUnion(malId);
  if (mal.status === 'failed') {
    return {
      ...jikan,
      malHttpStatus: mal.malHttpStatus,
    };
  }

  return mergeOfficialIntoJikan(jikan, mal);
}

export function formatMalThemeFailureDetail(result: MalThemeFetchResult): string {
  return formatJikanFailureDetail(result);
}
