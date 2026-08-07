import {
  fetchTenraiThemes,
  formatTenraiFailureDetail,
  unionTenraiThemesData,
  type TenraiThemesData,
  type TenraiThemesFetchResult,
} from './tenraiApi';
import { fetchMalOfficialThemes, isMalOfficialApiConfigured } from './malOfficialApi';

export type MalThemeProvider = 'tenrai' | 'mal-official';

export type MalThemeFetchResult = TenraiThemesFetchResult & {
  provider?: MalThemeProvider;
};

export type MalThemeFetchHints = {
  /** Opening/Ending/Insert hits from the matched AniPlaylist cluster. */
  aniplaylistThemeCount?: number;
  aniplaylistEndingCount?: number;
};

function countThemes(data: TenraiThemesData | null | undefined): number {
  if (!data) {
    return 0;
  }
  return data.openings.length + data.endings.length;
}

function isThinVersusAniplaylist(
  tenrai: TenraiThemesFetchResult,
  hints: MalThemeFetchHints,
): boolean {
  const total = countThemes(tenrai.data);
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
    (tenrai.data?.endings.length ?? 0) === 0
  ) {
    return true;
  }
  return false;
}

function mergeOfficialIntoTenrai(
  tenrai: MalThemeFetchResult,
  official: TenraiThemesFetchResult,
): MalThemeFetchResult {
  const merged = unionTenraiThemesData(tenrai.data, official.data);
  if (merged.openings.length === 0 && merged.endings.length === 0) {
    return {
      ...tenrai,
      data: merged,
      status: tenrai.status === 'failed' ? 'failed' : 'empty',
      malHttpStatus: official.malHttpStatus,
    };
  }
  return {
    ...tenrai,
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
 * Tenrai first (themes + full union), then official MyAnimeList API when Tenrai
 * fails or when AniPlaylist suggests more themes than Tenrai returned.
 */
export async function fetchMalThemeStrings(malId: number): Promise<MalThemeFetchResult> {
  const tenrai = await fetchTenraiThemes(malId);
  if (tenrai.status !== 'failed') {
    return { ...tenrai, provider: 'tenrai' };
  }

  if (!isMalOfficialApiConfigured()) {
    return tenrai;
  }

  const mal = await fetchOfficialMalUnion(malId);
  if (mal.status === 'failed') {
    return {
      ...tenrai,
      malHttpStatus: mal.malHttpStatus,
      status: 'failed',
    };
  }

  return {
    ...mal,
    themesHttpStatus: tenrai.themesHttpStatus,
    fullHttpStatus: tenrai.fullHttpStatus,
  };
}

/**
 * After AniPlaylist search, retry official MAL when Tenrai's union looks incomplete.
 */
export async function enrichMalThemesWithOfficialIfNeeded(
  tenrai: MalThemeFetchResult,
  malId: number,
  hints: MalThemeFetchHints,
): Promise<MalThemeFetchResult> {
  if (!isMalOfficialApiConfigured()) {
    return tenrai;
  }
  if (!isThinVersusAniplaylist(tenrai, hints)) {
    return tenrai;
  }

  const mal = await fetchOfficialMalUnion(malId);
  if (mal.status === 'failed') {
    return {
      ...tenrai,
      malHttpStatus: mal.malHttpStatus,
    };
  }

  return mergeOfficialIntoTenrai(tenrai, mal);
}

export function formatMalThemeFailureDetail(result: MalThemeFetchResult): string {
  return formatTenraiFailureDetail(result);
}
