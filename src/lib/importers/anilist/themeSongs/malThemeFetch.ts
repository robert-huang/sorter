import {
  fetchJikanThemes,
  formatJikanFailureDetail,
  type JikanThemesFetchResult,
} from './jikanApi';
import { fetchMalOfficialThemes, isMalOfficialApiConfigured } from './malOfficialApi';

export type MalThemeProvider = 'jikan' | 'mal-official';

export type MalThemeFetchResult = JikanThemesFetchResult & {
  provider?: MalThemeProvider;
};

/**
 * Jikan first, then official MyAnimeList API when Jikan themes + full both fail
 * (e.g. 504 gateway timeouts).
 */
export async function fetchMalThemeStrings(malId: number): Promise<MalThemeFetchResult> {
  const jikan = await fetchJikanThemes(malId);
  if (jikan.status !== 'failed') {
    return { ...jikan, provider: 'jikan' };
  }

  if (!isMalOfficialApiConfigured()) {
    return jikan;
  }

  const mal = await fetchMalOfficialThemes(malId);
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
    provider: 'mal-official',
  };
}

export function formatMalThemeFailureDetail(result: MalThemeFetchResult): string {
  return formatJikanFailureDetail(result);
}
