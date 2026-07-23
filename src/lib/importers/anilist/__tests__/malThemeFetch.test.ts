import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJikanThemes, formatJikanFailureDetail } from '../themeSongs/jikanApi';
import { fetchMalOfficialThemes, isMalOfficialApiConfigured } from '../themeSongs/malOfficialApi';
import {
  fetchMalThemeStrings,
  formatMalThemeFailureDetail,
} from '../themeSongs/malThemeFetch';

vi.mock('../themeSongs/jikanApi', () => ({
  fetchJikanThemes: vi.fn(),
  formatJikanFailureDetail: vi.fn(),
}));

vi.mock('../themeSongs/malOfficialApi', () => ({
  fetchMalOfficialThemes: vi.fn(),
  isMalOfficialApiConfigured: vi.fn(),
}));

const fetchJikanThemesMock = vi.mocked(fetchJikanThemes);
const fetchMalOfficialThemesMock = vi.mocked(fetchMalOfficialThemes);
const isMalOfficialApiConfiguredMock = vi.mocked(isMalOfficialApiConfigured);
const formatJikanFailureDetailMock = vi.mocked(formatJikanFailureDetail);

describe('fetchMalThemeStrings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMalOfficialApiConfiguredMock.mockReturnValue(true);
  });

  it('returns Jikan result when Jikan succeeds', async () => {
    fetchJikanThemesMock.mockResolvedValue({
      status: 'ok',
      data: { openings: ['1: "OP" by A'], endings: [] },
      themesHttpStatus: 200,
    });

    const result = await fetchMalThemeStrings(1);

    expect(result).toMatchObject({
      provider: 'jikan',
      status: 'ok',
    });
    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
  });

  it('falls back to official MAL API when Jikan themes and full both fail', async () => {
    fetchJikanThemesMock.mockResolvedValue({
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

  it('keeps Jikan failure when MAL API is not configured', async () => {
    isMalOfficialApiConfiguredMock.mockReturnValue(false);
    fetchJikanThemesMock.mockResolvedValue({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
    });

    const result = await fetchMalThemeStrings(2);

    expect(result.status).toBe('failed');
    expect(fetchMalOfficialThemesMock).not.toHaveBeenCalled();
  });

  it('merges MAL failure status into Jikan failure detail', async () => {
    fetchJikanThemesMock.mockResolvedValue({
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
  it('delegates to formatJikanFailureDetail', () => {
    formatJikanFailureDetailMock.mockReturnValue('themes 504, full 504, mal 503');
    const result = formatMalThemeFailureDetail({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
      malHttpStatus: 503,
    });
    expect(result).toBe('themes 504, full 504, mal 503');
    expect(formatJikanFailureDetailMock).toHaveBeenCalled();
  });
});
