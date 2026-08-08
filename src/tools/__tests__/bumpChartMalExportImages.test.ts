import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import type { Item } from '../../lib/types';
import {
  _resetBumpMalExportImagesForTesting,
  clearBumpMalExportImageUrls,
  resolveBumpMalExportImage,
} from '../panels/bumpChartMalExportImages';

const executeAnilistQuery = vi.hoisted(() => vi.fn());

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery,
}));

const MAL_IMAGE = 'https://cdn.myanimelist.net/images/anime/4/19644.jpg';
const REFRESHED_MAL_IMAGE =
  'https://cdn.myanimelist.net/images/anime/4/refreshed.jpg';

function item(
  kind: 'anilist' | 'anilist-character' | 'anilist-staff',
  externalId: number,
  label: string,
): Item {
  return {
    id: `${kind}:${externalId}`,
    label,
    imageUrl: 'https://s4.anilist.co/file/anilistcdn/test.jpg',
    source: { kind, externalId },
    searchTokens: [label],
  };
}

beforeEach(async () => {
  localStorage.clear();
  await _resetDisposableCacheDbForTesting();
  vi.stubEnv('VITE_MAL_CLIENT_ID', 'test-mal-client-id');
  vi.stubEnv('VITE_MAL_PROXY_URL', 'https://mal-proxy.test/mal');
  executeAnilistQuery.mockReset();
  _resetBumpMalExportImagesForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Bump Chart MAL export image matching', () => {
  it.each([
    ['ANIME', '/v2/anime/1?fields=main_picture'],
    ['MANGA', '/v2/manga/1?fields=main_picture'],
  ] as const)('uses an exact AniList MAL id for %s', async (type, path) => {
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          main_picture: { large: MAL_IMAGE },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const resolved = await resolveBumpMalExportImage(
      item('anilist', 10, 'Cowboy Bebop'),
    );

    expect(fetchMock).toHaveBeenCalledWith(`https://mal-proxy.test/mal${path}`, {
      headers: { Accept: 'application/json' },
    });
    expect(resolved?.url).toBe(MAL_IMAGE);
  });

  it('accepts a unique character only from a linked AniList entry', async () => {
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Spike Spiegel',
          native: 'スパイク・スピーゲル',
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 1, idMal: 1, type: 'ANIME' }] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              character: {
                mal_id: 11,
                name: 'Spiegel, Spike',
                images: { jpg: { image_url: MAL_IMAGE } },
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const resolved = await resolveBumpMalExportImage(
      item('anilist-character', 1, 'Spike Spiegel'),
    );

    expect(resolved?.url).toBe(MAL_IMAGE);
  });

  it('falls back to the linked official MAL anime cast after a Tenrai 504', async () => {
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Spike Spiegel',
          native: 'スパイク・スピーゲル',
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 1, idMal: 1, type: 'ANIME' }] },
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = input.toString();
        if (url.startsWith('https://api.tenrai.org/')) {
          return new Response(null, { status: 504 });
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                node: {
                  id: 11,
                  first_name: 'Spike',
                  last_name: 'Spiegel',
                  alternative_name: '',
                  main_picture: { medium: MAL_IMAGE },
                },
              },
            ],
          }),
          { status: 200 },
        );
      });

    const resolved = await resolveBumpMalExportImage(
      item('anilist-character', 1, 'Spike Spiegel'),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://mal-proxy.test/mal/v2/anime/1/characters?',
      ),
      { headers: { Accept: 'application/json' } },
    );
    expect(resolved?.url).toBe(MAL_IMAGE);
  });

  it('does not use the MAL anime cast fallback for non-504 Tenrai failures', async () => {
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Spike Spiegel',
          native: null,
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 1, idMal: 1, type: 'ANIME' }] },
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    await expect(
      resolveBumpMalExportImage(
        item('anilist-character', 1, 'Spike Spiegel'),
      ),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not call the nonexistent MAL manga cast endpoint after a Tenrai 504', async () => {
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Guts',
          native: 'ガッツ',
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 2, idMal: 2, type: 'MANGA' }] },
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 504 }),
    );

    await expect(
      resolveBumpMalExportImage(
        item('anilist-character', 2, 'Guts'),
      ),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/v2/manga/2/characters'),
      expect.anything(),
    );
  });

  it('rejects ambiguous linked-show character matches', async () => {
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Alex',
          native: null,
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 1, idMal: 1, type: 'ANIME' }] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              character: {
                mal_id: 11,
                name: 'Alex',
                images: { jpg: { image_url: MAL_IMAGE } },
              },
            },
            {
              character: {
                mal_id: 12,
                name: 'Alex',
                images: {
                  jpg: {
                    image_url:
                      'https://cdn.myanimelist.net/images/characters/12.jpg',
                  },
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      resolveBumpMalExportImage(item('anilist-character', 1, 'Alex')),
    ).resolves.toBeNull();
  });

  it('ignores null AniList characters while verifying voice actor credits', async () => {
    executeAnilistQuery.mockResolvedValue({
      Staff: {
        name: {
          full: 'Kouichi Yamadera',
          native: '山寺宏一',
          alternative: [],
        },
        characterMedia: {
          edges: [
            {
              node: { id: 1, idMal: 1, type: 'ANIME' },
              characters: [
                null,
                {
                  name: {
                    full: 'Spike Spiegel',
                    native: 'スパイク・スピーゲル',
                    alternative: [],
                    alternativeSpoiler: [],
                  },
                },
              ],
            },
          ],
        },
        staffMedia: { edges: [] },
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = input.toString();
        const data = url.includes('/people?')
          ? [
              {
                mal_id: 11,
                name: 'Yamadera, Kouichi',
                images: { jpg: { image_url: MAL_IMAGE } },
              },
            ]
          : {
              mal_id: 11,
              name: 'Yamadera, Kouichi',
              images: { jpg: { image_url: MAL_IMAGE } },
              voices: [
                {
                  anime: { mal_id: 1 },
                  character: { name: 'Spiegel, Spike' },
                },
              ],
              anime: [],
              manga: [],
            };
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

    const resolved = await resolveBumpMalExportImage(
      item('anilist-staff', 11, 'Kouichi Yamadera'),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/people?'),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tenrai.org/v1/people/11/full',
      expect.anything(),
    );
    expect(resolved?.url).toBe(MAL_IMAGE);
  });

  it('rejects a same-name staff candidate without a linked credit', async () => {
    executeAnilistQuery.mockResolvedValue({
      Staff: {
        name: { full: 'Kouichi Yamadera', native: null, alternative: [] },
        characterMedia: { edges: [] },
        staffMedia: {
          edges: [{ node: { id: 1, idMal: 1, type: 'ANIME' } }],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const data = input.toString().includes('/people?')
        ? [{ mal_id: 11, name: 'Yamadera, Kouichi' }]
        : {
            mal_id: 11,
            name: 'Yamadera, Kouichi',
            images: { jpg: { image_url: MAL_IMAGE } },
            voices: [],
            anime: [{ anime: { mal_id: 999 } }],
            manga: [],
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    await expect(
      resolveBumpMalExportImage(item('anilist-staff', 11, 'Kouichi Yamadera')),
    ).resolves.toBeNull();
  });

  it('accepts an exact staff name with a linked production credit', async () => {
    executeAnilistQuery.mockResolvedValue({
      Staff: {
        name: { full: 'Shinichirou Watanabe', native: null, alternative: [] },
        characterMedia: { edges: [] },
        staffMedia: {
          edges: [{ node: { id: 1, idMal: 1, type: 'ANIME' } }],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const data = input.toString().includes('/people?')
        ? [{ mal_id: 2009, name: 'Watanabe, Shinichirou' }]
        : {
            mal_id: 2009,
            name: 'Watanabe, Shinichirou',
            images: { jpg: { image_url: MAL_IMAGE } },
            voices: [],
            anime: [{ anime: { mal_id: 1 } }],
            manga: [],
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const resolved = await resolveBumpMalExportImage(
      item('anilist-staff', 1, 'Shinichirou Watanabe'),
    );

    expect(resolved?.url).toBe(MAL_IMAGE);
  });

  it('reuses a persisted successful resolution without new API calls', async () => {
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type: 'ANIME' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          main_picture: { large: MAL_IMAGE },
        }),
        { status: 200 },
      ),
    );
    const mediaItem = item('anilist', 10, 'Cowboy Bebop');

    await resolveBumpMalExportImage(mediaItem);
    _resetBumpMalExportImagesForTesting();
    executeAnilistQuery.mockClear();
    fetchMock.mockClear();
    const restored = await resolveBumpMalExportImage(mediaItem);

    expect(restored?.url).toBe(MAL_IMAGE);
    expect(executeAnilistQuery).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('migrates legacy URL mappings into individual disposable records', async () => {
    localStorage.setItem(
      'queue-sorter:bump-mal-export-image-urls:v1',
      JSON.stringify({
        'anilist:10': MAL_IMAGE,
        'anilist:11': 'https://example.com/not-mal.jpg',
      }),
    );

    const restored = await resolveBumpMalExportImage(
      item('anilist', 10, 'Cowboy Bebop'),
    );

    expect(restored).toEqual({
      url: MAL_IMAGE,
      cacheKey:
        'https://queue-sorter.invalid/bump-mal-export/v1/anilist%3A10',
    });
    expect(localStorage.getItem('queue-sorter:bump-mal-export-image-urls:v1')).toBeNull();
    expect(executeAnilistQuery).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent matching for the same entity', async () => {
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type: 'ANIME' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          main_picture: { large: MAL_IMAGE },
        }),
        { status: 200 },
      ),
    );
    const mediaItem = item('anilist', 10, 'Cowboy Bebop');

    const [first, second] = await Promise.all([
      resolveBumpMalExportImage(mediaItem),
      resolveBumpMalExportImage(mediaItem),
    ]);

    expect(first).toEqual(second);
    expect(executeAnilistQuery).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight lookup before forcing one fresh resolution', async () => {
    let signalQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      signalQueryStarted = resolve;
    });
    let releaseFirstQuery!: () => void;
    const firstQueryReleased = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    executeAnilistQuery
      .mockImplementationOnce(async () => {
        signalQueryStarted();
        await firstQueryReleased;
        return { Media: { id: 10, idMal: 1, type: 'ANIME' } };
      })
      .mockResolvedValue({
        Media: { id: 10, idMal: 1, type: 'ANIME' },
      });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ main_picture: { large: MAL_IMAGE } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ main_picture: { large: REFRESHED_MAL_IMAGE } }),
          { status: 200 },
        ),
      );
    const mediaItem = item('anilist', 10, 'Cowboy Bebop');

    const initial = resolveBumpMalExportImage(mediaItem);
    await queryStarted;
    const refreshed = resolveBumpMalExportImage(mediaItem, {
      forceRefresh: true,
    });
    releaseFirstQuery();

    await expect(initial).resolves.toMatchObject({ url: MAL_IMAGE });
    await expect(refreshed).resolves.toMatchObject({
      url: REFRESHED_MAL_IMAGE,
    });
    expect(executeAnilistQuery).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-persist a URL lookup that finishes after cache cleanup', async () => {
    let signalQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      signalQueryStarted = resolve;
    });
    let releaseQuery!: () => void;
    const queryReleased = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    executeAnilistQuery
      .mockImplementationOnce(async () => {
        signalQueryStarted();
        await queryReleased;
        return { Media: { id: 10, idMal: 1, type: 'ANIME' } };
      })
      .mockResolvedValue({
        Media: { id: 10, idMal: 1, type: 'ANIME' },
      });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ main_picture: { large: MAL_IMAGE } }),
        { status: 200 },
      ),
    );
    const mediaItem = item('anilist', 10, 'Cowboy Bebop');

    const initial = resolveBumpMalExportImage(mediaItem);
    await queryStarted;
    await clearBumpMalExportImageUrls();
    releaseQuery();
    await initial;
    _resetBumpMalExportImagesForTesting();

    await resolveBumpMalExportImage(mediaItem);

    expect(executeAnilistQuery).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serializes Tenrai requests from concurrent resolutions', async () => {
    executeAnilistQuery.mockImplementation(
      async (_query: string, variables: { id: number }) => ({
        Character: {
          name: {
            full: `Character ${variables.id}`,
            native: null,
            alternative: [],
            alternativeSpoiler: [],
          },
          media: {
            nodes: [
              { id: variables.id, idMal: variables.id, type: 'ANIME' },
            ],
          },
        },
      }),
    );
    let active = 0;
    let maxActive = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await Promise.all([
      resolveBumpMalExportImage(
        item('anilist-character', 1, 'Character 1'),
      ),
      resolveBumpMalExportImage(
        item('anilist-character', 2, 'Character 2'),
      ),
    ]);

    expect(maxActive).toBe(1);
  });

  it('honors a Tenrai 429 retry before resolving', async () => {
    vi.useFakeTimers();
    executeAnilistQuery.mockResolvedValue({
      Character: {
        name: {
          full: 'Spike Spiegel',
          native: null,
          alternative: [],
          alternativeSpoiler: [],
        },
        media: { nodes: [{ id: 1, idMal: 1, type: 'ANIME' }] },
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                character: {
                  mal_id: 11,
                  name: 'Spiegel, Spike',
                  images: { jpg: { image_url: MAL_IMAGE } },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const resolution = resolveBumpMalExportImage(
      item('anilist-character', 1, 'Spike Spiegel'),
    );
    await vi.runAllTimersAsync();

    await expect(resolution).resolves.toMatchObject({ url: MAL_IMAGE });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
