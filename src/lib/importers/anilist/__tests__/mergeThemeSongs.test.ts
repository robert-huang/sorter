import { describe, expect, it } from 'vitest';
import { parseMalThemes } from '../themeSongs/malThemeParser';
import {
  artistsRoughlyMatch,
  borrowSharedSpotifyMetadata,
  compareThemeSongRowsWithinType,
  mergeThemeSongs,
  sortOrderFromAniplaylistSongKey,
  themeSongMinEpisode,
} from '../themeSongs/mergeThemeSongs';
import type { MediaThemeSongRow } from '../themeSongs/types';
import type { AniplaylistHit } from '../themeSongs/aniplaylistApi';

describe('artistsRoughlyMatch', () => {
  it('matches flipped Latin name order with shared CV credit', () => {
    expect(
      artistsRoughlyMatch(
        'Chin-lan Chang (CV: Maki Kawase)',
        'Chang Chin-lan (CV: Maki Kawase)',
      ),
    ).toBe(true);
  });

  it('does not match different performers on the same title', () => {
    expect(artistsRoughlyMatch('Artist A', 'Artist B')).toBe(false);
  });

  it('matches Japanese romanization variants on artist tokens', () => {
    expect(artistsRoughlyMatch('Yuiko Oohara', 'Yuiko Ohara')).toBe(true);
  });
});

describe('sortOrderFromAniplaylistSongKey', () => {
  it('maps ED6 to sort order 5', () => {
    expect(sortOrderFromAniplaylistSongKey('ED6', 'Ending')).toBe(5);
  });

  it('parses ED prefix before episode suffix', () => {
    expect(sortOrderFromAniplaylistSongKey('ED6 (ep 1)', 'Ending')).toBe(5);
  });
});

describe('mergeThemeSongs', () => {
  it('outer-joins mal-only and aniplaylist-only rows', () => {
    const mal = parseMalThemes(['"Only MAL" by Singer'], []);
    const aniHit: AniplaylistHit = {
      id: 1,
      anime_id: 99,
      score: 50,
      titles: ['Only AniPlaylist'],
      song_key: 'IN ep 11',
      song_type: 'Insert',
      artists: [{ names: ['Band'] }],
      links: [],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows.some((r) => r.displayTitle === 'Only MAL')).toBe(true);
    expect(rows.some((r) => r.displayTitle === 'Only AniPlaylist')).toBe(true);
  });

  it('merges matching mal and aniplaylist rows', () => {
    const mal = parseMalThemes(['"Kore Kaite Shine" by BURNOUT SYNDROMES'], []);
    const aniHit: AniplaylistHit = {
      id: 2,
      anime_id: 100,
      score: 60,
      titles: ['Kore Kaite Shine'],
      song_key: 'OP',
      song_type: 'Opening',
      artists: [{ names: ['BURNOUT SYNDROMES'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/0xiPPtrQgUp9dB0Z3oQ3x8',
        },
      ],
      other_link_ids: ['0xiPPtrQgUp9dB0Z3oQ3x8'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.songKey).toBe('OP');
    expect(rows[0]?.malTitle).toBe('Kore Kaite Shine');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('merges MAL opening with AniPlaylist Theme Song / TS (Chainsaw Man Reze-hen)', () => {
    const mal = parseMalThemes(['"IRIS OUT" by Kenshi Yonezu (米津玄師)'], []);
    const aniHit: AniplaylistHit = {
      id: 25459,
      anime_id: 7113,
      score: 70.33,
      titles: ['IRIS OUT'],
      song_key: 'TS',
      song_type: 'Theme Song',
      artists: [{ names: ['Kenshi Yonezu', '米津玄師'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/59hVbgr8rfYkDbHfr8RcGI',
        },
      ],
      other_link_ids: ['3540533651'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.malTitle).toBe('IRIS OUT');
    expect(rows[0]?.type).toBe('Opening');
    expect(rows[0]?.spotifyTrackIds).toContain('59hVbgr8rfYkDbHfr8RcGI');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('merges when aniplaylist artist name order differs from MAL', () => {
    const mal = parseMalThemes(
      [],
      ['6: "Kanjou Glass (感情グラス)" by Chin-lan Chang (CV: Maki Kawase)'],
    );
    const aniHit: AniplaylistHit = {
      id: 3,
      anime_id: 101,
      score: 55,
      titles: ['Kanjou Glass'],
      song_key: 'ED6',
      song_type: 'Ending',
      artists: [{ names: ['Chang Chin-lan (CV: Maki Kawase)'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/abc123def456ghi789jkl',
        },
      ],
      other_link_ids: ['abc123def456ghi789jkl'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.malTitle).toBe('Kanjou Glass (感情グラス)');
    expect(rows[0]?.songKey).toBe('ED6');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('merges Takagi OP despite Oohara vs Ohara romanization', () => {
    const mal = parseMalThemes(['"Zero Centimeter" by Yuiko Oohara'], []);
    const aniHit: AniplaylistHit = {
      id: 5,
      anime_id: 1483,
      score: 60,
      titles: ['Zero Centimeter'],
      song_key: 'OP',
      song_type: 'Opening',
      artists: [{ names: ['Yuiko Ohara'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/abc123def456ghi789jkl',
        },
      ],
      other_link_ids: ['abc123def456ghi789jkl'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.malTitle).toBe('Zero Centimeter');
    expect(rows[0]?.hasResolvableTrackId).toBe(true);
  });

  it('uses aniplaylist song_key sort order for orphan rows', () => {
    const aniHit: AniplaylistHit = {
      id: 4,
      anime_id: 102,
      score: 40,
      titles: ['Orphan ED'],
      song_key: 'ED6',
      song_type: 'Ending',
      artists: [{ names: ['Singer'] }],
      links: [],
    };

    const rows = mergeThemeSongs([], [aniHit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sortOrder).toBe(5);
    expect(rows[0]?.songKey).toBe('ED6');
  });

  it('uses aniplaylist labels for orphans when MAL is missing', () => {
    const hits: AniplaylistHit[] = [
      {
        id: 10,
        anime_id: 38993,
        score: 50,
        titles: ['Kanade'],
        song_key: 'ED1 (ep 1)',
        song_type: 'Ending',
        artists: [{ names: ['Takagi-san'] }],
        links: [],
      },
      {
        id: 11,
        anime_id: 38993,
        score: 49,
        titles: ['Konayuki'],
        song_key: 'ED2 (ep 2)',
        song_type: 'Ending',
        artists: [{ names: ['Takagi-san'] }],
        links: [],
      },
    ];

    const rows = mergeThemeSongs([], hits);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
    expect(rows.every((r) => r.sortOrder < 100)).toBe(true);
  });

  it('borrows Spotify metadata when MAL duplicates the same song across OP and ED', () => {
    const mal = parseMalThemes(
      ['"終宵" by マカロニえんぴつ'],
      ['"終宵" by マカロニえんぴつ (ep 1)', '"名もない花" by 黒子首 (eps 1-)'],
    );
    const aniHit: AniplaylistHit = {
      id: 20,
      anime_id: 200,
      score: 60,
      titles: ['終宵'],
      song_key: 'OP',
      song_type: 'Opening',
      artists: [{ names: ['マカロニえんぴつ'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/shuuyoiTrackId12',
        },
      ],
      other_link_ids: ['shuuyoiTrackId12'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    const op = rows.find((row) => row.type === 'Opening');
    const duplicateEd = rows.find(
      (row) => row.type === 'Ending' && row.displayTitle === '終宵',
    );
    const realEd = rows.find((row) => row.displayTitle === '名もない花');

    expect(op?.hasResolvableTrackId).toBe(true);
    expect(duplicateEd?.spotifyTrackIds).toEqual(op?.spotifyTrackIds);
    expect(duplicateEd?.hasResolvableTrackId).toBe(true);
    expect(realEd?.hasResolvableTrackId).toBe(false);
  });

  it('borrows Spotify metadata when OP uses romanized MAL strings (World Is Dancing)', () => {
    const mal = parseMalThemes(
      ['"Shuushou" by Macaroni Empitsu'],
      ['"終宵" by マカロニえんぴつ (ep 1)', '"名もない花" by 黒子首 (eps 1-)'],
    );
    const aniHit: AniplaylistHit = {
      id: 21,
      anime_id: 201,
      score: 60,
      titles: ['終宵', 'Shuushou'],
      song_key: 'OP',
      song_type: 'Opening',
      artists: [{ names: ['マカロニえんぴつ', 'Macaroni Empitsu'] }],
      links: [
        {
          platform: 'spotify',
          main: true,
          link: 'https://open.spotify.com/track/shuuyoiTrackId12',
        },
      ],
      other_link_ids: ['shuuyoiTrackId12'],
    };

    const rows = mergeThemeSongs(mal, [aniHit]);
    const duplicateEd = rows.find(
      (row) => row.type === 'Ending' && row.displayTitle === '終宵',
    );

    expect(duplicateEd?.spotifyTrackIds).toEqual(['shuuyoiTrackId12']);
    expect(duplicateEd?.hasResolvableTrackId).toBe(true);
  });

  it('merges Jikan malformed ED quotes with AniPlaylist', () => {
    const mal = parseMalThemes(
      ['"Eureka Evrika (ユーレカ・エヴリカ)" by Luna Goami (五阿弥ルナ)'],
      [`''Soarin\u2019'' by Ginger Root`],
    );
    const hits: AniplaylistHit[] = [
      {
        id: 1,
        anime_id: 62856,
        score: 50,
        titles: ['ユーレカ・エヴリカ'],
        song_key: 'OP',
        song_type: 'Opening',
        artists: [{ names: ['五阿弥ルナ'] }],
        links: [],
      },
      {
        id: 2,
        anime_id: 62856,
        score: 49,
        titles: ["Soarin'"],
        song_key: 'ED',
        song_type: 'Ending',
        artists: [{ names: ['Ginger Root'] }],
        links: [
          {
            platform: 'spotify',
            main: true,
            link: 'https://open.spotify.com/track/soarinTrackId12',
          },
        ],
        other_link_ids: ['soarinTrackId12'],
      },
    ];

    const rows = mergeThemeSongs(mal, hits);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'Ending')).toHaveLength(1);
    expect(rows.find((r) => r.type === 'Ending')?.hasResolvableTrackId).toBe(true);
  });
});

describe('compareThemeSongRowsWithinType', () => {
  function endingRow(
    partial: Partial<MediaThemeSongRow> & Pick<MediaThemeSongRow, 'displayTitle'>,
  ): MediaThemeSongRow {
    return {
      type: 'Ending',
      sortOrder: 0,
      displayArtist: null,
      spotifyUrl: null,
      spotifyTrackIds: [],
      spotifyIsrc: null,
      hasResolvableTrackId: false,
      ...partial,
    };
  }

  it('sorts by appearance index then earliest episode number', () => {
    const rows = [
      endingRow({ displayTitle: '感情グラス', songKey: 'ED (ep 6 & 8)' }),
      endingRow({ displayTitle: '感情グラス', songKey: 'ED (ep 1 & 12)' }),
      endingRow({ displayTitle: '感情グラス', songKey: 'ED (ep 4)' }),
      endingRow({ displayTitle: '茜色の夕日', songKey: 'ED (ep 10)' }),
      endingRow({ displayTitle: '感情グラス', songKey: 'ED (ep 3 & 9)' }),
    ].sort(compareThemeSongRowsWithinType);

    expect(rows.map((row) => themeSongMinEpisode(row))).toEqual([1, 3, 4, 6, 10]);
  });

  it('sorts OP before OP2', () => {
    const rows = [
      {
        type: 'Opening' as const,
        sortOrder: 1,
        displayTitle: 'OP2',
        displayArtist: null,
        spotifyUrl: null,
        spotifyTrackIds: [],
        spotifyIsrc: null,
        hasResolvableTrackId: false,
      },
      {
        type: 'Opening' as const,
        sortOrder: 0,
        displayTitle: 'OP',
        displayArtist: null,
        spotifyUrl: null,
        spotifyTrackIds: [],
        spotifyIsrc: null,
        hasResolvableTrackId: false,
      },
    ].sort(compareThemeSongRowsWithinType);

    expect(rows.map((row) => row.displayTitle)).toEqual(['OP', 'OP2']);
  });
});

describe('borrowSharedSpotifyMetadata', () => {
  it('does not borrow across different songs', () => {
    const donor: MediaThemeSongRow = {
      type: 'Opening',
      sortOrder: 0,
      displayTitle: 'Song A',
      displayArtist: 'Artist A',
      spotifyUrl: 'https://open.spotify.com/track/a',
      spotifyTrackIds: ['track-a'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };
    const recipient: MediaThemeSongRow = {
      type: 'Ending',
      sortOrder: 0,
      displayTitle: 'Song B',
      displayArtist: 'Artist B',
      spotifyUrl: null,
      spotifyTrackIds: [],
      spotifyIsrc: null,
      hasResolvableTrackId: false,
    };

    const rows = borrowSharedSpotifyMetadata([donor, recipient]);
    expect(rows[1]?.spotifyTrackIds).toEqual([]);
  });

  it('does not borrow when titles match but artists differ', () => {
    const donor: MediaThemeSongRow = {
      type: 'Opening',
      sortOrder: 0,
      displayTitle: 'Go',
      displayArtist: 'Artist A',
      malTitle: 'Go',
      malArtist: 'Artist A',
      spotifyUrl: 'https://open.spotify.com/track/go-a',
      spotifyTrackIds: ['track-go-a'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };
    const recipient: MediaThemeSongRow = {
      type: 'Ending',
      sortOrder: 0,
      displayTitle: 'Go',
      displayArtist: 'Artist B',
      malTitle: 'Go',
      malArtist: 'Artist B',
      spotifyUrl: null,
      spotifyTrackIds: [],
      spotifyIsrc: null,
      hasResolvableTrackId: false,
    };

    const rows = borrowSharedSpotifyMetadata([donor, recipient]);
    expect(rows[1]?.spotifyTrackIds).toEqual([]);
  });
});
