import { afterEach, describe, expect, it, vi } from 'vitest';
import { spotifyApiFetch } from '../spotifyApi';
import {
  fetchPlaylistTracks,
  parseLocalPlaylistTrackItemForTesting,
  parsePlaylistTrackItemForTesting,
} from '../spotifyPlaylist';

vi.mock('../spotifyApi', () => ({
  spotifyApiFetch: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('parsePlaylistTrackItemForTesting', () => {
  it('reads track id from the new item field', () => {
    const parsed = parsePlaylistTrackItemForTesting({
      item: {
        id: 'track-new',
        type: 'track',
        external_ids: { isrc: 'USRC001' },
      },
      linked_from: { id: 'track-old' },
    });
    expect(parsed).toEqual({
      id: 'track-new',
      isrc: 'USRC001',
      linkedFromIds: ['track-old'],
    });
  });

  it('falls back to legacy track field', () => {
    const parsed = parsePlaylistTrackItemForTesting({
      track: {
        id: 'track-legacy',
        external_ids: { isrc: 'USRC002' },
      },
    });
    expect(parsed).toEqual({
      id: 'track-legacy',
      isrc: 'USRC002',
      linkedFromIds: [],
    });
  });

  it('skips non-track items', () => {
    const parsed = parsePlaylistTrackItemForTesting({
      item: {
        id: 'episode-1',
        type: 'episode',
      },
    });
    expect(parsed).toBeNull();
  });

  it('retains local-file metadata without requiring a Spotify id', () => {
    const parsed = parseLocalPlaylistTrackItemForTesting(
      {
        is_local: true,
        item: {
          id: null,
          type: 'track',
          name: 'Houkiboshi (TV Size)',
          is_local: true,
          uri: 'spotify:local:Younha:Bleach:Houkiboshi+%28TV+Size%29:89',
          duration_ms: 89_000,
          artists: [{ name: 'Younha' }, { name: 'ユンナ' }],
          album: { name: 'Bleach' },
          external_ids: {},
        },
      },
      17,
    );

    expect(parsed).toEqual({
      uri: 'spotify:local:Younha:Bleach:Houkiboshi+%28TV+Size%29:89',
      title: 'Houkiboshi (TV Size)',
      artists: ['Younha', 'ユンナ'],
      album: 'Bleach',
      durationMs: 89_000,
      playlistPosition: 17,
    });
  });
});

describe('fetchPlaylistTracks', () => {
  it('paginates with offset when the playlist spans multiple pages', async () => {
    vi.mocked(spotifyApiFetch).mockImplementation(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      const pageSize = offset === 0 ? 50 : 25;
      const items = Array.from({ length: pageSize }, (_, index) =>
        offset === 50 && index === 0
          ? {
              is_local: true,
              item: {
                type: 'track',
                name: 'Second-page local file',
                is_local: true,
                artists: [{ name: 'Artist' }],
              },
            }
          : {
              item: {
                id: `track-${offset + index}`,
                type: 'track',
                external_ids: { isrc: null },
              },
            },
      );
      return {
        ok: true,
        json: async () => ({ items }),
      } as Response;
    });

    const { tracks, localTracks, playlistItemsFetched } = await fetchPlaylistTracks(
      'pl-big',
      'token',
    );

    expect(tracks).toHaveLength(74);
    expect(localTracks[0]?.playlistPosition).toBe(51);
    expect(playlistItemsFetched).toBe(75);
    expect(spotifyApiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spotifyApiFetch).mock.calls[1]?.[0]).toContain('offset=50');
  });

  it('caches local files separately while counting every fetched playlist item', async () => {
    vi.mocked(spotifyApiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 3,
        items: [
          {
            item: {
              id: 'track-1',
              type: 'track',
              name: 'ウンディーネ',
              artists: [{ name: 'Yui Makino' }],
              album: { name: 'ウンディーネ' },
              duration_ms: 345_426,
              external_ids: { isrc: null },
            },
          },
          {
            is_local: true,
            item: {
              id: null,
              type: 'track',
              name: 'Local OP',
              is_local: true,
              uri: 'spotify:local:Artist:Album:Local+OP:90',
              duration_ms: 90_000,
              artists: [{ name: 'Artist' }],
              album: { name: 'Album' },
            },
          },
          {
            item: {
              id: 'track-2',
              type: 'track',
              external_ids: { isrc: null },
            },
          },
        ],
      }),
    } as Response);

    const result = await fetchPlaylistTracks('pl-local', 'token');

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]?.metadata).toEqual({
      title: 'ウンディーネ',
      artists: ['Yui Makino'],
      album: 'ウンディーネ',
      durationMs: 345_426,
      playlistPosition: 1,
    });
    expect(result.localTracks).toEqual([
      {
        uri: 'spotify:local:Artist:Album:Local+OP:90',
        title: 'Local OP',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 90_000,
        playlistPosition: 2,
      },
    ]);
    expect(result.trackTotal).toBe(3);
    expect(result.playlistItemsFetched).toBe(3);
    const requestedFields = new URL(
      vi.mocked(spotifyApiFetch).mock.calls[0]?.[0] ?? '',
    ).searchParams.get('fields');
    expect(requestedFields).toContain('name,is_local,uri,duration_ms');
    expect(requestedFields).toContain('artists(name)');
  });
});
