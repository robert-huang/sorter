import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dedupeThemeStrings,
  fetchJikanThemes,
  unionJikanThemesData,
} from '../themeSongs/jikanApi';

describe('dedupeThemeStrings', () => {
  it('dedupes by parsed title and artist across quote variants', () => {
    const merged = dedupeThemeStrings([
      `''Soarin'' by Ginger Root`,
      `Soarin' by Ginger Root`,
    ]);
    expect(merged).toHaveLength(1);
  });
});

describe('unionJikanThemesData', () => {
  it('merges openings and endings from both sources', () => {
    const merged = unionJikanThemesData(
      { openings: ['1: "OP" by A'], endings: [] },
      { openings: [], endings: ['1: "ED" by B'] },
    );
    expect(merged.openings).toEqual(['1: "OP" by A']);
    expect(merged.endings).toEqual(['1: "ED" by B']);
  });
});

describe('fetchJikanThemes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches themes and full in parallel and unions results', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/themes')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { openings: ['1: "OP" by A'], endings: [] },
          }),
        } as Response;
      }
      if (url.endsWith('/full')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { theme: { openings: [], endings: ['1: "ED" by B'] } },
          }),
        } as Response;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await fetchJikanThemes(42);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'ok',
      themesHttpStatus: 200,
      fullHttpStatus: 200,
      data: {
        openings: ['1: "OP" by A'],
        endings: ['1: "ED" by B'],
      },
    });
  });

  it('returns failed when both endpoints error without theme payloads', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 504,
      json: async () => ({}),
    } as Response);

    const result = await fetchJikanThemes(99);

    expect(result).toMatchObject({
      status: 'failed',
      data: null,
      themesHttpStatus: 504,
      fullHttpStatus: 504,
    });
  });

  it('keeps themes from /themes when /full is empty', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/themes')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { openings: ['1: "OP" by A'], endings: ['1: "ED" by B'] },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { theme: { openings: [], endings: [] } },
        }),
      } as Response;
    });

    const result = await fetchJikanThemes(7);

    expect(result.status).toBe('ok');
    expect(result.data?.endings).toEqual(['1: "ED" by B']);
  });
});
