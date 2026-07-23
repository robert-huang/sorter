import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('normalizeMalOfficialThemeLine', () => {
  it('strips hash prefix from official MAL API theme numbers', async () => {
    const { normalizeMalOfficialThemeLine } = await import('../themeSongs/malOfficialApi');
    expect(normalizeMalOfficialThemeLine('#1: "takt" by ryo')).toBe('1: "takt" by ryo');
    expect(normalizeMalOfficialThemeLine('  #2: "ending" by artist  ')).toBe(
      '2: "ending" by artist',
    );
  });

  it('leaves Jikan-style numbered lines unchanged', async () => {
    const { normalizeMalOfficialThemeLine } = await import('../themeSongs/malOfficialApi');
    expect(normalizeMalOfficialThemeLine('1: "Kanade" by Takagi-san')).toBe(
      '1: "Kanade" by Takagi-san',
    );
  });
});

describe('resolveMalApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the local Vite proxy path in dev', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_MAL_PROXY_URL', '');
    vi.stubEnv('DEV', true);
    const { resolveMalApiBaseUrl, MAL_LOCAL_PROXY_PATH } = await import(
      '../themeSongs/malOfficialApi'
    );
    expect(resolveMalApiBaseUrl()).toBe(MAL_LOCAL_PROXY_PATH);
  });
});

describe('fetchMalOfficialThemes', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_MAL_CLIENT_ID', 'test-mal-client-id');
    vi.stubEnv('VITE_MAL_PROXY_URL', '');
    vi.stubEnv('DEV', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('calls the proxied MAL themes endpoint without client id header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        opening_themes: [{ text: '#1: "OP" by Artist A' }],
        ending_themes: [{ text: '#1: "ED" by Artist B (eps 1-12)' }],
      }),
    });

    const { fetchMalOfficialThemes } = await import('../themeSongs/malOfficialApi');
    const result = await fetchMalOfficialThemes(12345);

    expect(result).toMatchObject({
      status: 'ok',
      malHttpStatus: 200,
      data: {
        openings: ['1: "OP" by Artist A'],
        endings: ['1: "ED" by Artist B (eps 1-12)'],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/mal/v2/anime/12345?fields=opening_themes,ending_themes',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: 'application/json',
    });
  });

  it('returns failed with malHttpStatus when the anime request fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const { fetchMalOfficialThemes } = await import('../themeSongs/malOfficialApi');
    const result = await fetchMalOfficialThemes(42);

    expect(result).toEqual({
      data: null,
      status: 'failed',
      malHttpStatus: 503,
    });
  });
});
