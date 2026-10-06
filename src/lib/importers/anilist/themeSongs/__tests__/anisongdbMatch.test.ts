import { describe, expect, it } from 'vitest';
import type { AnisongdbSearchHit } from '../anisongdbApi';
import {
  parseAnisongdbSongType,
  pickBestAnisongdbHit,
  resolveAnisongdbPreviewFromHits,
} from '../anisongdbMatch';
import type { MediaThemeSongRow } from '../types';

const SAMPLE_HITS: AnisongdbSearchHit[] = [
  {
    annId: 37027,
    annSongId: 49725,
    animeENName: 'Grow Up Show',
    animeJPName: 'Grow Up Show: Himawari no Circus-dan',
    songType: 'Opening 1',
    songName: 'Yurari Yureru',
    songArtist: 'NOMELON NOLEMON',
    HQ: 'b9tbae.webm',
    MQ: null,
    audio: 'bbmoii.mp3',
    linked_ids: { anilist: 196017 },
  },
  {
    annId: 1736,
    annSongId: 3947,
    animeENName: 'Ghost Stories',
    animeJPName: 'Gakkou no Kaidan',
    songType: 'Opening 1',
    songName: 'Grow Up',
    songArtist: 'Hysteric Blue',
    HQ: null,
    MQ: 'mcrsbz.webm',
    audio: 'tc8ne4.mp3',
    linked_ids: { anilist: 1281 },
  },
  {
    annId: 20598,
    annSongId: 19095,
    animeENName: 'Uma Musume: Pretty Derby',
    animeJPName: 'Uma Musume: Pretty Derby',
    songType: 'Ending 1',
    songName: 'Grow Up Shine!',
    songArtist: 'Azumi Waki, Marika Kohno, Machico',
    HQ: '9egnoo.webm',
    MQ: null,
    audio: '94juo8.mp3',
    linked_ids: { anilist: 35249 },
  },
];

const FLASHBULB_HIT: AnisongdbSearchHit = {
  annId: 38789,
  annSongId: 49554,
  animeENName: 'Hana-Kimi',
  animeJPName: 'Hana-Kimi',
  animeAltName: ['Hanazakari no Kimi-tachi e'],
  songType: 'Opening 1',
  songName: 'FLASHBULB',
  songArtist: 'Omoinotake',
  HQ: 't02cpg.webm',
  MQ: null,
  audio: 'nx7o5a.mp3',
  linked_ids: { anilist: 209669 },
};

function row(overrides: Partial<MediaThemeSongRow> = {}): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 0,
    displayTitle: 'Grow Up',
    displayArtist: 'Hysteric Blue',
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
    ...overrides,
  };
}

describe('parseAnisongdbSongType', () => {
  it('parses opening and ending numbers', () => {
    expect(parseAnisongdbSongType('Opening 1')).toEqual({
      type: 'Opening',
      sortOrder: 0,
    });
    expect(parseAnisongdbSongType('Ending 2')).toEqual({
      type: 'Ending',
      sortOrder: 1,
    });
    expect(parseAnisongdbSongType('Insert Song')).toEqual({
      type: 'Insert',
      sortOrder: null,
    });
  });
});

describe('pickBestAnisongdbHit', () => {
  it('picks Ghost Stories Grow Up by artist among similar titles', () => {
    const hit = pickBestAnisongdbHit(SAMPLE_HITS, {
      mediaId: 1281,
      animeTitle: 'Ghost Stories',
      row: row(),
      songTitle: 'Grow Up',
      songArtist: 'Hysteric Blue',
    });
    expect(hit?.annSongId).toBe(3947);
  });

  it('picks FLASHBULB for Omoinotake OP without requiring anilist id', () => {
    const hit = pickBestAnisongdbHit([FLASHBULB_HIT], {
      mediaId: 999999,
      animeTitle: 'Hanazakari no Kimitachi e 2nd Season',
      row: row({
        displayTitle: 'FLASHBULB',
        displayArtist: 'Omoinotake',
      }),
      songTitle: 'FLASHBULB',
      songArtist: 'Omoinotake',
    });
    expect(hit?.annSongId).toBe(49554);
  });

  it('rejects wrong song type when title and artist collide', () => {
    const hit = pickBestAnisongdbHit(SAMPLE_HITS, {
      mediaId: 1281,
      animeTitle: 'Ghost Stories',
      row: row({ type: 'Opening', displayTitle: 'Grow Up Shine!', displayArtist: 'Azumi Waki' }),
      songTitle: 'Grow Up Shine!',
      songArtist: 'Azumi Waki',
    });
    expect(hit).toBeNull();
  });
});

describe('resolveAnisongdbPreviewFromHits', () => {
  it('uses MQ webm when HQ is missing', () => {
    const preview = resolveAnisongdbPreviewFromHits(SAMPLE_HITS, {
      mediaId: 1281,
      animeTitle: 'Ghost Stories',
      row: row(),
      songTitle: 'Grow Up',
      songArtist: 'Hysteric Blue',
    });
    expect(preview?.videoUrl).toContain('mcrsbz.webm');
    expect(preview?.audioUrl).toContain('tc8ne4.mp3');
  });
});
