import { describe, expect, it } from 'vitest';
import type { MediaThemeSongRow } from '../../importers/anilist/themeSongs/types';
import {
  aggregatePlaylistMatchForRows,
  collectPlaylistArtistMatchCandidates,
  matchThemeRowToPlaylist,
  matchThemeRowToPlaylistDetails,
  normalizePlaylistTitleForMatch,
} from '../spotifyPlaylistMatch';
import type { SpotifyPlaylistCache } from '../spotifyPlaylist';

function makeRow(overrides: Partial<MediaThemeSongRow> = {}): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 0,
    displayTitle: 'Test Song',
    displayArtist: 'Artist',
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
    ...overrides,
  };
}

const cache: SpotifyPlaylistCache = {
  playlistId: 'pl1',
  fetchedAt: Date.now(),
  tracks: [
    { id: 'track-a', isrc: 'USRC111', linkedFromIds: ['track-b'] },
    { id: 'track-c', isrc: 'USRC222', linkedFromIds: [] },
  ],
};

function cacheWithLocalTracks(
  localTracks: NonNullable<SpotifyPlaylistCache['localTracks']>,
): SpotifyPlaylistCache {
  return {
    playlistId: 'pl-local',
    fetchedAt: Date.now(),
    tracks: [],
    localTracks,
  };
}

describe('playlist metadata normalization', () => {
  it.each([
    {
      value:
        'ソフィー・トワイライト(CV：富田美憂)、天野灯(CV：篠原侑)、夏木ひなた(CV：Lynn)',
      expected: ['富田美憂', '篠原侑', 'lynn'],
    },
    {
      value:
        '勇者パーティー<ユーシャ(CV：赤尾ひかる)、セイラ(CV：夏川椎菜)、ファイ(CV：小澤亜李)>',
      expected: ['赤尾ひかる', '夏川椎菜', '小澤亜李'],
    },
    {
      value:
        'スピカ [スペシャルウィーク (CV.和氣あず未)、サイレンススズカ (CV.高野麻里佳)、トウカイテイオー (CV.Machico)]',
      expected: ['和氣あず未', '高野麻里佳', 'machico'],
    },
    {
      value: '栗山未来（種田梨沙）/名瀬美月（茅原実里）/新堂愛（山岡ゆり）',
      expected: ['種田梨沙', '茅原実里', '山岡ゆり'],
    },
    {
      value: 'ゆの(CV.阿澄佳奈)×宮子(CV.水橋かおり)',
      expected: ['阿澄佳奈', '水橋かおり'],
    },
    {
      value: 'アリス(CV.広橋涼) with アテナ(CV.河井英里)',
      expected: ['広橋涼', '河井英里'],
    },
    {
      value: 'supercell feat. Ann, gaku',
      expected: ['supercell', 'ann', 'gaku'],
    },
    {
      value: 'Senjougahara Hitagi (C.V. Saitou Chiwa)',
      expected: ['saitou chiwa'],
    },
    {
      value: 'Ｓｏｐｈｉｅ（ＣＶ：富田美憂）＆Ａｋａｒｉ（Ｃ．Ｖ．篠原侑）',
      expected: ['sophie', '富田美憂', 'akari', '篠原侑'],
    },
  ])('extracts complete names and credits from $value', ({ value, expected }) => {
    const candidates = collectPlaylistArtistMatchCandidates([value]);
    for (const name of expected) {
      expect(candidates).toContain(name);
    }
  });

  it('distinguishes Japanese middle-dot name punctuation from artist separators', () => {
    expect(collectPlaylistArtistMatchCandidates(['井口裕香・早見沙織'])).toEqual(
      expect.arrayContaining(['井口裕香', '早見沙織']),
    );
    expect(
      collectPlaylistArtistMatchCandidates([
        '澤村・スペンサー・英梨々(CV.大西沙織)＆霞ヶ丘詩羽(CV.茅野愛衣)',
      ]),
    ).toEqual(
      expect.arrayContaining(['澤村 スペンサー 英梨々', '大西沙織', '霞ヶ丘詩羽', '茅野愛衣']),
    );
    expect(collectPlaylistArtistMatchCandidates(['ソフィー・トワイライト'])).not.toContain(
      'ソフィー',
    );
  });

  it.each([
    ['ソフィー', 'ソフィー・トワイライト'],
    ['Yui', 'Yui Makino'],
  ])('does not treat partial artist name %s as complete %s', (sourceArtist, cachedArtist) => {
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'Distinctive Song Name',
        displayArtist: sourceArtist,
      }),
      cacheWithLocalTracks([
        {
          uri: 'spotify:local:Artist:Album:Distinctive+Song+Name:180',
          title: 'Distinctive Song Name',
          artists: [cachedArtist],
          album: 'Album',
          durationMs: 180_000,
          playlistPosition: 1,
        },
      ]),
    );

    expect(result).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it.each([
    ['Makino Yui', 'Yui Makino'],
    ['Asumi Kana', 'Kana Asumi'],
    ['Taneshima Popura', 'Popura Taneshima'],
  ])('canonicalizes reversed romanized name order: %s / %s', (left, right) => {
    const leftCandidates = collectPlaylistArtistMatchCandidates([left]);
    const rightCandidates = collectPlaylistArtistMatchCandidates([right]);
    expect(leftCandidates.some((candidate) => rightCandidates.includes(candidate))).toBe(true);
  });

  it.each([
    ['目蓋の裏 (TV ver.)', '目蓋の裏'],
    ['星座になれたら -Anime Ver.-', '星座になれたら'],
    ['愛してる(TVサイズ)', '愛してる'],
    ['Ｆｌｏｗｅｒ (ＴＶ Ｓｉｚｅ)', 'flower'],
  ])('removes broadcast-edit title markers from %s', (title, expected) => {
    expect(normalizePlaylistTitleForMatch(title)).toBe(expected);
  });

  it('preserves Japanese voicing marks while folding Latin accents', () => {
    expect(normalizePlaylistTitleForMatch('ウンディーネ Pokémon')).toBe(
      'ウンディーネ pokemon',
    );
  });

  it.each([
    ['Flower Psychedelic (TVサイズ セリフなし)', 'flower psychedelic セリフなし'],
    ['Undine - Forest Mix', 'undine forest mix'],
    ['Secret in my heart [instrumental]', 'secret in my heart instrumental'],
    ['etoile et toi [edition le blanc]', 'etoile et toi edition le blanc'],
  ])('preserves meaningful title qualifiers from %s', (title, expected) => {
    expect(normalizePlaylistTitleForMatch(title)).toBe(expected);
  });
});

describe('matchThemeRowToPlaylist', () => {
  it('matches direct track id', () => {
    const row = makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('matches linked_from id', () => {
    const row = makeRow({ spotifyTrackIds: ['track-b'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('matches by isrc', () => {
    const row = makeRow({ spotifyIsrc: 'USRC222', hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('returns out when track id is resolvable but absent', () => {
    const row = makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('out');
  });

  it('returns unknown without cache', () => {
    const row = makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, null)).toBe('unknown');
  });

  it('matches alternate spotify id via lazy track isrc lookup', () => {
    const row = makeRow({
      spotifyTrackIds: ['2ReLy6MAZB0lw65E7utuIt'],
      hasResolvableTrackId: true,
    });
    const connectCache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      tracks: [{ id: '6SrKLkuqWyKxSxzvtRWvX5', isrc: 'JPU901001861', linkedFromIds: [] }],
    };
    const lookup = new Map([['2ReLy6MAZB0lw65E7utuIt', 'JPU901001861']]);
    expect(
      matchThemeRowToPlaylist(row, connectCache, {
        trackIsrcById: lookup,
        isrcLookupReady: true,
      }),
    ).toBe('in');
  });

  it('waits for lazy isrc lookup before reporting out', () => {
    const row = makeRow({
      spotifyTrackIds: ['2ReLy6MAZB0lw65E7utuIt'],
      hasResolvableTrackId: true,
    });
    expect(
      matchThemeRowToPlaylist(row, cache, {
        trackIsrcById: new Map(),
        isrcLookupReady: false,
      }),
    ).toBe('unknown');
  });

  it('matches track id parsed from spotifyUrl when spotifyTrackIds is empty', () => {
    const row = makeRow({
      spotifyTrackIds: [],
      spotifyUrl: 'https://open.spotify.com/track/1ZD4E53dzpTyjkcrYZcdQB',
      hasResolvableTrackId: true,
    });
    const houkiboshiCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '1ZD4E53dzpTyjkcrYZcdQB', isrc: null, linkedFromIds: [] }],
    };
    expect(matchThemeRowToPlaylist(row, houkiboshiCache)).toBe('in');
  });

  it('bridges Japan vs global Houkiboshi catalog ids via ISRC', () => {
    const sharedIsrc = 'JPCO02503650';
    const row = makeRow({
      spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB', '6gYV0M8HLVwW6tKQfzv7Jk'],
      spotifyUrl: 'https://open.spotify.com/track/6gYV0M8HLVwW6tKQfzv7Jk',
      hasResolvableTrackId: true,
    });
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '1ZD4E53dzpTyjkcrYZcdQB', isrc: sharedIsrc, linkedFromIds: [] }],
    };
    expect(
      matchThemeRowToPlaylist(row, playlistCache, {
        trackIsrcById: new Map([
          ['6gYV0M8HLVwW6tKQfzv7Jk', sharedIsrc],
          ['1ZD4E53dzpTyjkcrYZcdQB', sharedIsrc],
        ]),
        isrcLookupReady: true,
      }),
    ).toBe('in');
  });

  it('reports out when only spotifyUrl has a track id', () => {
    const row = makeRow({
      spotifyTrackIds: [],
      spotifyUrl: 'https://open.spotify.com/track/missing-from-playlist',
      hasResolvableTrackId: false,
    });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('out');
  });

  it('reports out when track is beyond a truncated 50-track playlist cache', () => {
    const row = makeRow({
      spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB'],
      spotifyUrl: 'https://open.spotify.com/track/1ZD4E53dzpTyjkcrYZcdQB',
      hasResolvableTrackId: true,
    });
    const truncatedCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `filler-track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(matchThemeRowToPlaylist(row, truncatedCache)).toBe('out');
  });

  it('matches normalized local-file title and artist metadata', () => {
    const localTrack = {
      uri: 'spotify:local:Younha:Bleach:Houkiboshi:89',
      title: 'Houkiboshi (TV Size)',
      artists: ['Younha', 'ユンナ'],
      album: 'Bleach',
      durationMs: 89_000,
      playlistPosition: 17,
    };
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'Houkiboshi',
        displayArtist: 'YOUNHA',
      }),
      cacheWithLocalTracks([localTrack]),
    );

    expect(result).toEqual({
      status: 'in',
      metadataMatch: { kind: 'local', track: localTrack },
    });
  });

  it.each([
    {
      title: 'NOW!!!GAMBLE',
      cachedArtist: '種島ぽぷら(阿澄佳奈)・伊波まひる(藤田咲)・轟八千代(喜多村英梨)',
      sourceArtist:
        'Popura Taneshima (Kana Asumi), Mahiru Inami (Saki Fujita), Yachiyo Todoroki (Eri Kitamura)',
      playlistPosition: 6,
    },
    {
      title: 'SOMEONE ELSE',
      cachedArtist:
        'Taneshima Popura (CV: Asumi Kana), Inami Mahiru (CV: Fujita Saki), Todoroki Yachiyo (CV: Kitamura Eri)',
      sourceArtist:
        'Popura Taneshima (Kana Asumi), Mahiru Inami (Saki Fujita), Yachiyo Todoroki (Eri Kitamura)',
      playlistPosition: 1,
    },
  ])(
    'accepts the MAL-only $title row with the observed local artist tag',
    ({ title, cachedArtist, sourceArtist, playlistPosition }) => {
      const localTrack = {
        uri: `spotify:local:Working:Working:${encodeURIComponent(title)}:240`,
        title,
        artists: [cachedArtist],
        album: 'WORKING!!!',
        durationMs: 240_000,
        playlistPosition,
      };
      const result = matchThemeRowToPlaylistDetails(
        makeRow({
          displayTitle: title,
          displayArtist: sourceArtist,
          malTitle: title,
          malArtist: sourceArtist,
        }),
        cacheWithLocalTracks([localTrack]),
      );

      expect(result).toEqual({
        status: 'in',
        metadataMatch: { kind: 'local', track: localTrack },
      });
    },
  );

  it('does not accept a unique exact title when artist metadata is incompatible', () => {
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'Again',
        displayArtist: 'YUI',
        aniTitles: ['Again'],
        aniArtists: ['YUI'],
      }),
      cacheWithLocalTracks([
        {
          uri: 'spotify:local:Noah+Cyrus:Again:Again:193',
          title: 'Again',
          artists: ['Noah Cyrus', 'XXXTENTACION'],
          album: 'Again',
          durationMs: 193_000,
          playlistPosition: 8,
        },
      ]),
    );

    expect(result).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it('does not trust a short exact title when artist scripts cannot be compared', () => {
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'Pray',
        displayArtist: 'Haruka Chisuga',
        malTitle: 'Pray',
        malArtist: 'Haruka Chisuga',
      }),
      cacheWithLocalTracks([
        {
          uri: 'spotify:local:Rachel:Pray:Pray:247',
          title: 'Pray',
          artists: ['レイチェル(CV.千菅春香)'],
          album: 'BlazBlue',
          durationMs: 247_000,
          playlistPosition: 8,
        },
      ]),
    );

    expect(result).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it('uses MAL and AniPlaylist variants for conservative fuzzy local matching', () => {
    const localTrack = {
      uri: 'spotify:local:Younha:Bleach:Houkibosi:248',
      title: 'Houkibosi',
      artists: ['Younha'],
      album: 'Bleach',
      durationMs: 248_000,
      playlistPosition: 8,
    };
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'ほうき星',
        displayArtist: 'ユンナ',
        malTitle: 'ほうき星',
        malArtist: 'ユンナ',
        aniTitles: ['Houkiboshi', 'ほうき星'],
        aniArtists: ['Younha', 'ユンナ'],
      }),
      cacheWithLocalTracks([localTrack]),
    );

    expect(result).toEqual({
      status: 'in',
      metadataMatch: { kind: 'local', track: localTrack },
    });
  });

  it('does not report an ambiguous fuzzy local match', () => {
    const playlistCache = cacheWithLocalTracks([
      {
        uri: 'spotify:local:Artist:Album:Houkibosi:248',
        title: 'Houkibosi',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 248_000,
        playlistPosition: 3,
      },
      {
        uri: 'spotify:local:Artist:Album:Houkiboshu:248',
        title: 'Houkiboshu',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 248_000,
        playlistPosition: 9,
      },
    ]);

    expect(
      matchThemeRowToPlaylistDetails(
        makeRow({ displayTitle: 'Houkiboshi', displayArtist: 'Artist' }),
        playlistCache,
      ),
    ).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it('does not guess between exact same-title local files when source artist is unknown', () => {
    const playlistCache = cacheWithLocalTracks([
      {
        uri: 'spotify:local:Artist+One:Album:Home:180',
        title: 'Home',
        artists: ['Artist One'],
        album: 'Album',
        durationMs: 180_000,
        playlistPosition: 2,
      },
      {
        uri: 'spotify:local:Artist+Two:Album:Home:190',
        title: 'Home',
        artists: ['Artist Two'],
        album: 'Album',
        durationMs: 190_000,
        playlistPosition: 7,
      },
    ]);

    expect(
      matchThemeRowToPlaylistDetails(
        makeRow({ displayTitle: 'Home', displayArtist: null }),
        playlistCache,
      ),
    ).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it('does not let a matching artist compensate for an unrelated local title', () => {
    const playlistCache = cacheWithLocalTracks([
      {
        uri: 'spotify:local:Artist:Album:Different+Song:180',
        title: 'Different Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180_000,
        playlistPosition: 4,
      },
    ]);

    expect(matchThemeRowToPlaylist(makeRow(), playlistCache)).toBe('unknown');
  });

  it('metadata-matches a catalog edition when its id and ISRC do not match', () => {
    const undineMetadata = {
      title: 'ウンディーネ',
      artists: ['Yui Makino'],
      album: 'ウンディーネ',
      durationMs: 345_426,
      playlistPosition: 1,
    };
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '2XrM7E60lAUFwtwXV7Qlbj',
      fetchedAt: Date.now(),
      tracks: [
        {
          id: '4gpO9yuVjymsfTVehDXw3Q',
          isrc: null,
          linkedFromIds: [],
          metadata: undineMetadata,
        },
      ],
      localTracks: [],
      metadataVersion: 1,
    };
    const result = matchThemeRowToPlaylistDetails(
      makeRow({
        displayTitle: 'Undine (ウンディーネ)',
        displayArtist: 'Makino Yui',
        spotifyTrackIds: ['41EFjyvs5g7Ga3ii1kE2aa'],
        hasResolvableTrackId: true,
      }),
      playlistCache,
    );

    expect(result).toEqual({
      status: 'in',
      metadataMatch: { kind: 'spotify', track: undineMetadata },
    });
  });

  it('does not substring-match the base Undine row to a different mix', () => {
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '2XrM7E60lAUFwtwXV7Qlbj',
      fetchedAt: Date.now(),
      tracks: [
        {
          id: '0AKzWVQgLjvs5OCV5VO7OG',
          isrc: null,
          linkedFromIds: [],
          metadata: {
            title: 'ウンディーネ -forest mix-',
            artists: ['Yui Makino'],
            album: 'ARIA The ANIMATION',
            durationMs: 103_093,
            playlistPosition: 3,
          },
        },
      ],
      localTracks: [],
      metadataVersion: 1,
    };

    expect(
      matchThemeRowToPlaylistDetails(
        makeRow({
          displayTitle: 'Undine',
          displayArtist: 'Yui Makino',
          aniTitles: ['Undine', 'ウンディーネ'],
          aniArtists: ['Yui Makino', '牧野由依'],
        }),
        playlistCache,
      ),
    ).toEqual({ status: 'unknown', metadataMatch: null });
  });

  it('prefers an exact Spotify catalog match over local metadata', () => {
    const playlistCache: SpotifyPlaylistCache = {
      ...cache,
      localTracks: [
        {
          uri: 'spotify:local:Artist:Album:Test+Song:180',
          title: 'Test Song',
          artists: ['Artist'],
          album: 'Album',
          durationMs: 180_000,
          playlistPosition: 4,
        },
      ],
    };

    expect(
      matchThemeRowToPlaylistDetails(
        makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
        playlistCache,
      ),
    ).toEqual({ status: 'in', metadataMatch: null });
  });
});

describe('aggregatePlaylistMatchForRows', () => {
  it('returns mixed when some resolvable rows match and some do not', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('mixed');
  });

  it('returns in when all resolvable rows match', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyIsrc: null, spotifyTrackIds: [], hasResolvableTrackId: false }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('in');
  });

  it('counts a local-file metadata match as on the playlist', () => {
    const playlistCache = cacheWithLocalTracks([
      {
        uri: 'spotify:local:Artist:Album:Test+Song:180',
        title: 'Test Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180_000,
        playlistPosition: 4,
      },
    ]);

    expect(aggregatePlaylistMatchForRows([makeRow()], playlistCache)).toBe('in');
  });

  it('returns out when every resolvable row is missing from the playlist', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true }),
      makeRow({ spotifyTrackIds: ['also-missing'], hasResolvableTrackId: true }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('out');
  });

  it('returns null when every row is unknown', () => {
    const rows = [makeRow({ hasResolvableTrackId: false })];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBeNull();
  });

  it('houkiboshi show is mixed when ED is on playlist and OP is not', () => {
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '6gYV0M8HLVwW6tKQfzv7Jk', isrc: 'JPCO02503650', linkedFromIds: [] }],
    };
    const rows = [
      makeRow({
        type: 'Opening',
        spotifyTrackIds: ['6nmRFTaSwwoZ2e2Q45Pa9l'],
        hasResolvableTrackId: true,
      }),
      makeRow({
        type: 'Ending',
        spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB', '6gYV0M8HLVwW6tKQfzv7Jk'],
        spotifyUrl: 'https://open.spotify.com/track/6gYV0M8HLVwW6tKQfzv7Jk',
        hasResolvableTrackId: true,
      }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, playlistCache)).toBe('mixed');
    expect(matchThemeRowToPlaylist(rows[1]!, playlistCache)).toBe('in');
    expect(matchThemeRowToPlaylist(rows[0]!, playlistCache)).toBe('out');
  });
});
