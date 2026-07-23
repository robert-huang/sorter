import { describe, expect, it } from 'vitest';
import { parsePlaylistTrackItemForTesting } from '../spotifyPlaylist';

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
