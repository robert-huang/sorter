import { describe, expect, it, vi } from 'vitest';
import {
  ANISONGDB_DIST_BASE_URL,
  AnisongdbRankedError,
  anisongdbRankedStatus,
  buildAnisongdbAnimeSearchBody,
  searchAnisongdb,
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

  it('reports the AMQ Ranked window from the regional schedule', () => {
    // 20:50 in Copenhagen (CET) on a winter day.
    expect(anisongdbRankedStatus(new Date('2026-11-22T19:50:00Z'))).toEqual({
      active: true,
      region: 'Central',
      remainingSeconds: 33 * 60,
    });
    expect(anisongdbRankedStatus(new Date('2026-11-22T05:00:00Z'))).toEqual({ active: false });
  });

  it('throws a ranked error for the ranked-time 503 and falls back to an anime search body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ detail: 'Song name/artist/composer text search is disabled during ranked time' }),
        { status: 503 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(searchAnisongdb('COOLISH WALK')).rejects.toBeInstanceOf(AnisongdbRankedError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(buildAnisongdbAnimeSearchBody(' Aharen ')).toEqual({
      anime_search_filter: { search: 'Aharen', partial_match: true },
      and_logic: false,
      ignore_duplicate: false,
    });
  });
});
