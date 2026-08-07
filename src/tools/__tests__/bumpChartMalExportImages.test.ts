import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';
import {
  _resetBumpMalExportImagesForTesting,
  resolveBumpMalExportImage,
} from '../panels/bumpChartMalExportImages';

const executeAnilistQuery = vi.hoisted(() => vi.fn());

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery,
}));

const MAL_IMAGE = 'https://cdn.myanimelist.net/images/anime/4/19644.jpg';

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

beforeEach(() => {
  localStorage.clear();
  executeAnilistQuery.mockReset();
  _resetBumpMalExportImagesForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Bump Chart MAL export image matching', () => {
  it.each([
    ['ANIME', '/anime/1'],
    ['MANGA', '/manga/1'],
  ] as const)('uses an exact AniList MAL id for %s', async (type, path) => {
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { mal_id: 1, images: { jpg: { image_url: MAL_IMAGE } } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const resolved = await resolveBumpMalExportImage(
      item('anilist', 10, 'Cowboy Bebop'),
    );

    expect(fetchMock).toHaveBeenCalledWith(`https://api.jikan.moe/v4${path}`, {
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

  it('requires a linked anime and character credit for voice actors', async () => {
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
      'https://api.jikan.moe/v4/people/11/full',
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
          data: { mal_id: 1, images: { jpg: { image_url: MAL_IMAGE } } },
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

  it('deduplicates concurrent matching for the same entity', async () => {
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type: 'ANIME' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { mal_id: 1, images: { jpg: { image_url: MAL_IMAGE } } },
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

  it('serializes Jikan requests from concurrent resolutions', async () => {
    executeAnilistQuery.mockImplementation(
      async (_query: string, variables: { id: number }) => ({
        Media: { id: variables.id, idMal: variables.id, type: 'ANIME' },
      }),
    );
    let active = 0;
    let maxActive = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return new Response(
        JSON.stringify({
          data: { mal_id: 1, images: { jpg: { image_url: MAL_IMAGE } } },
        }),
        { status: 200 },
      );
    });

    await Promise.all([
      resolveBumpMalExportImage(item('anilist', 1, 'One')),
      resolveBumpMalExportImage(item('anilist', 2, 'Two')),
    ]);

    expect(maxActive).toBe(1);
  });

  it('honors a Jikan 429 retry before resolving', async () => {
    vi.useFakeTimers();
    executeAnilistQuery.mockResolvedValue({
      Media: { id: 10, idMal: 1, type: 'ANIME' },
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
            data: { mal_id: 1, images: { jpg: { image_url: MAL_IMAGE } } },
          }),
          { status: 200 },
        ),
      );

    const resolution = resolveBumpMalExportImage(
      item('anilist', 10, 'Cowboy Bebop'),
    );
    await vi.runAllTimersAsync();

    await expect(resolution).resolves.toMatchObject({ url: MAL_IMAGE });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
