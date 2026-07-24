import { afterEach, describe, expect, it, vi } from 'vitest';
import { spotifyApiFetch } from '../spotifyApi';
import { fetchPlaylistTracks, parsePlaylistTrackItemForTesting } from '../spotifyPlaylist';

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
});

describe('fetchPlaylistTracks', () => {
  it('paginates with offset when the playlist spans multiple pages', async () => {
    vi.mocked(spotifyApiFetch).mockImplementation(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      const pageSize = offset === 0 ? 50 : 25;
      const items = Array.from({ length: pageSize }, (_, index) => ({
        item: {
          id: `track-${offset + index}`,
          type: 'track',
          external_ids: { isrc: null },
        },
      }));
      return {
        ok: true,
        json: async () => ({ items }),
      } as Response;
    });

    const tracks = await fetchPlaylistTracks('pl-big', 'token');

    expect(tracks).toHaveLength(75);
    expect(spotifyApiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spotifyApiFetch).mock.calls[1]?.[0]).toContain('offset=50');
  });
});
