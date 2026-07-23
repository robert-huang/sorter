import { describe, expect, it } from 'vitest';
import {
  buildAniplaylistSearchParams,
  ANIPLAYLIST_HITS_PER_PAGE,
  ANIPLAYLIST_LOCAL_PROXY_PATH,
  extractSeasonNumber,
  findMatchingAnimeCluster,
  groupHitsByAnimeId,
  isAniplaylistRemoteProxyUrl,
  resolveAniplaylistSearchUrl,
  scoreMediaToAnimeTitle,
  type AniplaylistHit,
} from '../themeSongs/aniplaylistApi';

function hit(
  partial: Partial<AniplaylistHit> & Pick<AniplaylistHit, 'anime_id' | 'score'>,
): AniplaylistHit {
  return {
    id: partial.id ?? 1,
    titles: partial.titles ?? ['Song'],
    song_key: partial.song_key ?? 'ED',
    song_type: partial.song_type ?? 'Ending',
    artists: partial.artists ?? [],
    links: [],
    ...partial,
  };
}

const TAKAGI_S2_ID = 1483;
const TAKAGI_S3_ID = 5060;

const takagiS2Hits: AniplaylistHit[] = [
  hit({
    id: 101,
    anime_id: TAKAGI_S2_ID,
    score: 59.52,
    anime_titles: ['Teasing Master Takagi-san 2', 'からかい上手の高木さん2'],
    titles: ['Zero Centimeter'],
    song_type: 'Opening',
    song_key: 'OP',
    artists: [{ names: ['Yuiko Oohara'] }],
  }),
  hit({
    id: 102,
    anime_id: TAKAGI_S2_ID,
    score: 58.1,
    anime_titles: ['Teasing Master Takagi-san 2'],
    titles: ['Kanade (奏（かなで）)'],
    song_type: 'Ending',
    song_key: 'ED',
    artists: [{ names: ['Takagi-san (Rie Takahashi)'] }],
  }),
];

const takagiS3Hits: AniplaylistHit[] = [
  hit({
    id: 201,
    anime_id: TAKAGI_S3_ID,
    score: 64.19,
    anime_titles: ['Teasing Master Takagi-san 3', 'からかい上手の高木さん3'],
    titles: ['Massugu'],
    song_type: 'Opening',
    song_key: 'OP',
    artists: [{ names: ['Yui Oohara'] }],
  }),
  hit({
    id: 202,
    anime_id: TAKAGI_S3_ID,
    score: 63.5,
    anime_titles: ['Teasing Master Takagi-san 3'],
    titles: ['Massugu - Larara ver.'],
    song_type: 'Opening',
    song_key: 'OP ep 6',
    artists: [{ names: ['Yui Oohara'] }],
  }),
  hit({
    id: 203,
    anime_id: TAKAGI_S3_ID,
    score: 62.2,
    anime_titles: ['Teasing Master Takagi-san 3'],
    titles: ['Santa ni Naritai'],
    song_type: 'Insert',
    song_key: 'IN ep 9',
    artists: [{ names: ['Yui Oohara'] }],
  }),
];

const takagiMediaTitles = {
  english: 'Teasing Master Takagi-san Season 2',
  romaji: 'Karakai Jouzu no Takagi-san 2',
  native: 'からかい上手の高木さん2',
};

const takagiMalThemes = [
  { type: 'Opening', title: 'Zero Centimeter', artist: 'Yuiko Oohara' },
  { type: 'Ending', title: 'Kanade', artist: 'Takagi-san (Rie Takahashi)' },
];

describe('extractSeasonNumber', () => {
  it('reads season numbers from English and Japanese titles', () => {
    expect(extractSeasonNumber('Teasing Master Takagi-san Season 2')).toBe(2);
    expect(extractSeasonNumber('Teasing Master Takagi-san 3')).toBe(3);
    expect(extractSeasonNumber('からかい上手の高木さん2')).toBe(2);
  });
});

describe('scoreMediaToAnimeTitle', () => {
  it('rejects season mismatches within the same franchise', () => {
    expect(
      scoreMediaToAnimeTitle(
        'Teasing Master Takagi-san Season 2',
        'Teasing Master Takagi-san 3',
      ),
    ).toBe(0);
    expect(
      scoreMediaToAnimeTitle(
        'Teasing Master Takagi-san Season 2',
        'Teasing Master Takagi-san 2',
      ),
    ).toBeGreaterThanOrEqual(90);
  });
});

describe('findMatchingAnimeCluster', () => {
  it('picks season 2 for Takagi-san even when season 3 has a higher Algolia score', () => {
    const clusters = groupHitsByAnimeId([...takagiS2Hits, ...takagiS3Hits]);
    const picked = findMatchingAnimeCluster(clusters, takagiMalThemes, takagiMediaTitles);
    expect(picked?.[0]?.anime_id).toBe(TAKAGI_S2_ID);
    expect(picked?.some((h) => h.titles.includes('Massugu'))).toBe(false);
  });

  it('picks season 2 from media titles when MAL themes are empty', () => {
    const clusters = groupHitsByAnimeId([...takagiS2Hits, ...takagiS3Hits]);
    const picked = findMatchingAnimeCluster(clusters, [], takagiMediaTitles);
    expect(picked?.[0]?.anime_id).toBe(TAKAGI_S2_ID);
  });

  it('does not fall back to the highest Algolia score when titles are ambiguous', () => {
    const clusters = groupHitsByAnimeId([...takagiS2Hits, ...takagiS3Hits]);
    const picked = findMatchingAnimeCluster(
      clusters,
      [],
      { english: 'Teasing Master Takagi-san', romaji: null, native: null },
    );
    expect(picked).toBeNull();
  });

  it('uses shared MAL song matching to break franchise ties', () => {
    const clusters = groupHitsByAnimeId([...takagiS2Hits, ...takagiS3Hits]);
    const picked = findMatchingAnimeCluster(
      clusters,
      takagiMalThemes,
      { english: 'Teasing Master Takagi-san', romaji: null, native: null },
    );
    expect(picked?.[0]?.anime_id).toBe(TAKAGI_S2_ID);
  });

  it('rejects a sole Algolia cluster when media titles do not match (Mofusand)', () => {
    const fluffyHits: AniplaylistHit[] = [
      hit({
        id: 901,
        anime_id: 7777,
        score: 58.73,
        anime_titles: [
          'Fluffy Paradise',
          'Isekai de Mofumofu Nadenade suru Mahou ni Tensei shitaken',
        ],
        titles: ['Massugu'],
        song_type: 'Opening',
        song_key: 'OP',
      }),
    ];
    const clusters = groupHitsByAnimeId(fluffyHits);
    const picked = findMatchingAnimeCluster(clusters, [], {
      english: 'Mofusand',
      romaji: 'Mofusand',
      native: 'モフサンド',
    });
    expect(picked).toBeNull();
  });
});

describe('buildAniplaylistSearchParams', () => {
  it('includes facets, query, and userToken like aniplaylist.com', () => {
    const params = new URLSearchParams(buildAniplaylistSearchParams('kore kaite shine', 0));
    expect(params.get('query')).toBe('kore kaite shine');
    expect(params.get('hitsPerPage')).toBe(String(ANIPLAYLIST_HITS_PER_PAGE));
    expect(params.get('page')).toBe('0');
    expect(params.get('userToken')).toMatch(/^anonymous-/);
    expect(JSON.parse(params.get('facets') ?? '[]')).toEqual([
      'links.label',
      'links.link_markets',
      'platforms',
      'season',
      'song_type',
      'status',
    ]);
  });
});

describe('resolveAniplaylistSearchUrl', () => {
  it('prefers VITE_ANIPLAYLIST_PROXY_URL when set, otherwise the local Vite proxy in dev', () => {
    const configured = import.meta.env.VITE_ANIPLAYLIST_PROXY_URL?.trim();
    const url = resolveAniplaylistSearchUrl();
    if (configured) {
      expect(url).toBe(configured);
    } else {
      expect(url).toBe(ANIPLAYLIST_LOCAL_PROXY_PATH);
    }
  });
});

describe('isAniplaylistRemoteProxyUrl', () => {
  it('treats the Cloudflare worker URL as remote', () => {
    expect(isAniplaylistRemoteProxyUrl('https://example.workers.dev')).toBe(true);
  });

  it('treats the local Vite proxy path as not remote', () => {
    expect(isAniplaylistRemoteProxyUrl(ANIPLAYLIST_LOCAL_PROXY_PATH)).toBe(false);
  });
});
