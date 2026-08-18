import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTenraiThemes, formatTenraiFailureDetail } from '../themeSongs/tenraiApi';
import { fetchMalOfficialThemes, isMalOfficialApiConfigured } from '../themeSongs/malOfficialApi';
import {
  enrichMalThemesWithOfficialIfNeeded,
  fetchMalThemeStrings,
  formatMalThemeFailureDetail,
  type MalThemeFetchResult,
} from '../themeSongs/malThemeFetch';

vi.mock('../themeSongs/tenraiApi', () => ({
  fetchTenraiThemes: vi.fn(),
  formatTenraiFailureDetail: vi.fn(),
  unionTenraiThemesData: vi.fn((...sources: Array<{ openings: string[]; endings: string[] } | null | undefined>) => {
    const openings: string[] = [];
    const endings: string[] = [];
    for (const source of sources) {
      if (!source) continue;
      openings.push(...source.openings);
      endings.push(...source.endings);
    }
    return { openings, endings };
  }),
}));

vi.mock('../themeSongs/malOfficialApi', () => ({
  fetchMalOfficialThemes: vi.fn(),
  isMalOfficialApiConfigured: vi.fn(),
}));

const fetchTenraiThemesMock = vi.mocked(fetchTenraiThemes);
const fetchMalOfficialThemesMock = vi.mocked(fetchMalOfficialThemes);
const isMalOfficialApiConfiguredMock = vi.mocked(isMalOfficialApiConfigured);
const formatTenraiFailureDetailMock = vi.mocked(formatTenraiFailureDetail);

describe('fetchMalThemeStrings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMalOfficialApiConfiguredMock.mockReturnValue(true);
  });

  it('returns Tenrai result when Tenrai succeeds', async () => {
    fetchTenraiThemesMock.mockResolvedValue({
      status: 'ok',
      data: { openings: ['1: "OP" by A'], endings: [] },
      themesHttpStatus: 200,
    });

    const result = await fetchMalThemeStrings(1);

    expect(result).toMatchObject({
      provider: 'tenrai',
      status: 'ok',
    });
    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
  });

  it('falls back to official MAL API when Tenrai themes and full both fail', async () => {
    fetchTenraiThemesMock.mockResolvedValue({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
    });
    fetchMalOfficialThemesMock.mockResolvedValue({
      status: 'ok',
      data: { openings: ['1: "OP" by A'], endings: ['1: "ED" by B'] },
      malHttpStatus: 200,
    });

    const result = await fetchMalThemeStrings(42897);

    expect(fetchMalOfficialThemesMock).toHaveBeenCalledWith(42897);
    expect(result).toMatchObject({
      provider: 'mal-official',
      status: 'ok',
      themesHttpStatus: 504,
      fullHttpStatus: 504,
      malHttpStatus: 200,
    });
  });

  it('keeps Tenrai failure when MAL API is not configured', async () => {
    isMalOfficialApiConfiguredMock.mockReturnValue(false);
    fetchTenraiThemesMock.mockResolvedValue({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
    });

    const result = await fetchMalThemeStrings(2);

    expect(result.status).toBe('failed');
    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
  });

  it('merges MAL failure status into Tenrai failure detail', async () => {
    fetchTenraiThemesMock.mockResolvedValue({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
    });
    fetchMalOfficialThemesMock.mockResolvedValue({
      status: 'failed',
      data: null,
      malHttpStatus: 503,
    });

    const result = await fetchMalThemeStrings(3);

    expect(result).toMatchObject({
      status: 'failed',
      themesHttpStatus: 504,
      fullHttpStatus: 504,
      malHttpStatus: 503,
    });
  });
});

describe('formatMalThemeFailureDetail', () => {
  it('delegates to formatTenraiFailureDetail', () => {
    formatTenraiFailureDetailMock.mockReturnValue('themes 504, full 504, mal 503');
    const result = formatMalThemeFailureDetail({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
      malHttpStatus: 503,
    });
    expect(result).toBe('themes 504, full 504, mal 503');
    expect(formatTenraiFailureDetailMock).toHaveBeenCalled();
  });
});

describe('enrichMalThemesWithOfficialIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMalOfficialApiConfiguredMock.mockReturnValue(true);
  });

  it('fetches official MAL when Tenrai union is thinner than AniPlaylist hints', async () => {
    const tenrai: MalThemeFetchResult = {
      status: 'ok',
      provider: 'tenrai',
      data: { openings: ['1: "OP" by A'], endings: [] },
      themesHttpStatus: 200,
      fullHttpStatus: 200,
    };
    fetchMalOfficialThemesMock.mockResolvedValue({
      status: 'ok',
      data: { openings: [], endings: ['1: "ED" by B'] },
      malHttpStatus: 200,
    });

    const result = await enrichMalThemesWithOfficialIfNeeded(tenrai, 123, {
      aniplaylistOpeningCount: 1,
      aniplaylistEndingCount: 1,
    });

    expect(fetchMalOfficialThemesMock).toHaveBeenCalledWith(123);
    expect(result.data?.endings).toEqual(['1: "ED" by B']);
    expect(result.provider).toBe('mal-official');
  });

  it('skips official MAL when Tenrai already covers AniPlaylist hints', async () => {
    const tenrai: MalThemeFetchResult = {
      status: 'ok',
      provider: 'tenrai',
      data: {
        openings: ['1: "OP" by A'],
        endings: ['1: "ED" by B'],
      },
      themesHttpStatus: 200,
      fullHttpStatus: 200,
    };

    const result = await enrichMalThemesWithOfficialIfNeeded(tenrai, 456, {
      aniplaylistOpeningCount: 1,
      aniplaylistEndingCount: 1,
    });

    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
    expect(result).toBe(tenrai);
  });

  it('does not treat AniPlaylist inserts as missing MAL themes', async () => {
    const tenrai: MalThemeFetchResult = {
      status: 'ok',
      provider: 'tenrai',
      data: {
        openings: ['"アイドル" by YOASOBI'],
        endings: [
          '1: "Idol (アイドル)" by YOASOBI (eps 1)',
          '2: "Mephisto (メフィスト)" by Ziyoou-vachi (eps 2-11)',
        ],
      },
      themesHttpStatus: 200,
      fullHttpStatus: 200,
    };

    const result = await enrichMalThemesWithOfficialIfNeeded(tenrai, 52034, {
      aniplaylistOpeningCount: 1,
      aniplaylistEndingCount: 1,
    });

    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
    expect(result).toBe(tenrai);
  });
});
