import { describe, expect, it } from 'vitest';
import {
  ANISONGDB_DIST_BASE_URL,
  buildAnisongdbMediaUrl,
  buildAnisongdbSearchBody,
  pickPlayableSource,
} from '../anisongdbApi';

describe('anisongdbApi', () => {
  it('builds title-only search body', () => {
    const body = buildAnisongdbSearchBody('FLASHBULB');
    expect(body.song_name_search_filter).toEqual({ search: 'FLASHBULB', partial_match: true });
    expect(body.anime_search_filter).toBeUndefined();
    expect(body.artist_search_filter).toBeUndefined();
    expect(body.and_logic).toBeUndefined();
  });

  it('builds media URLs from dist base', () => {
    expect(buildAnisongdbMediaUrl('b9tbae.webm')).toBe(
      `${ANISONGDB_DIST_BASE_URL}b9tbae.webm`,
    );
  });

  it('prefers HQ for video and keeps audio fallback', () => {
    const source = pickPlayableSource({
      annId: 1,
      annSongId: 2,
      animeENName: 'A',
      animeJPName: 'A',
      songType: 'Opening 1',
      songName: 'S',
      songArtist: 'X',
      HQ: 'hq.webm',
      MQ: null,
      audio: 'a.mp3',
      linked_ids: {},
    });
    expect(source.videoUrl).toContain('hq.webm');
    expect(source.audioUrl).toContain('a.mp3');
  });
});
