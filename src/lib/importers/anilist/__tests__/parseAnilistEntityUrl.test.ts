import { describe, expect, it } from 'vitest';
import { dedupRows, materializeItemFromRawRow } from '../../../csv';
import {
  anilistItemIdFromParsedEntity,
  enrichItemFromAnilistUrl,
  itemSourceFromParsedAnilistEntity,
  parseAnilistEntityUrl,
} from '../parseAnilistEntityUrl';

describe('parseAnilistEntityUrl', () => {
  it('parses anime and manga with optional title slug', () => {
    expect(parseAnilistEntityUrl('https://anilist.co/anime/21/One-Piece')).toEqual({
      kind: 'ANIME',
      externalId: 21,
      canonicalUrl: 'https://anilist.co/anime/21',
    });
    expect(parseAnilistEntityUrl('https://anilist.co/manga/30002')).toEqual({
      kind: 'MANGA',
      externalId: 30002,
      canonicalUrl: 'https://anilist.co/manga/30002',
    });
  });

  it('parses character, staff, and studio pages', () => {
    expect(parseAnilistEntityUrl('https://anilist.co/character/17')).toEqual({
      kind: 'CHARACTERS',
      externalId: 17,
      canonicalUrl: 'https://anilist.co/character/17',
    });
    expect(parseAnilistEntityUrl('https://anilist.co/staff/95011')).toEqual({
      kind: 'STAFF',
      externalId: 95011,
      canonicalUrl: 'https://anilist.co/staff/95011',
    });
    expect(parseAnilistEntityUrl('https://anilist.co/studio/43/Ghibli')).toEqual({
      kind: 'STUDIOS',
      externalId: 43,
      canonicalUrl: 'https://anilist.co/studio/43',
    });
  });

  it('accepts bare anilist.co paths without a scheme', () => {
    expect(parseAnilistEntityUrl('anilist.co/anime/9253')?.externalId).toBe(9253);
    expect(parseAnilistEntityUrl('www.anilist.co/manga/1')?.kind).toBe('MANGA');
  });

  it('rejects search, user, and API URLs', () => {
    expect(
      parseAnilistEntityUrl(
        'https://anilist.co/search/anime?year=2020&only%20show%20my%20anime=true',
      ),
    ).toBeNull();
    expect(parseAnilistEntityUrl('https://anilist.co/user/12345')).toBeNull();
    expect(parseAnilistEntityUrl('https://graphql.anilist.co')).toBeNull();
    expect(parseAnilistEntityUrl('https://anilist.co/api/v2/oauth/authorize')).toBeNull();
  });
});

describe('itemSourceFromParsedAnilistEntity', () => {
  it('maps media and person kinds to ItemSource variants', () => {
    const anime = parseAnilistEntityUrl('https://anilist.co/anime/1')!;
    expect(itemSourceFromParsedAnilistEntity(anime)).toEqual({
      kind: 'anilist',
      externalId: 1,
    });
    const character = parseAnilistEntityUrl('https://anilist.co/character/2')!;
    expect(itemSourceFromParsedAnilistEntity(character)).toEqual({
      kind: 'anilist-character',
      externalId: 2,
    });
    const staff = parseAnilistEntityUrl('https://anilist.co/staff/3')!;
    expect(itemSourceFromParsedAnilistEntity(staff)).toEqual({
      kind: 'anilist-staff',
      externalId: 3,
    });
    const studio = parseAnilistEntityUrl('https://anilist.co/studio/4')!;
    expect(itemSourceFromParsedAnilistEntity(studio)).toBeUndefined();
  });
});

describe('anilistItemIdFromParsedEntity', () => {
  it('matches AnilistStartMode id prefixes', () => {
    expect(
      anilistItemIdFromParsedEntity(parseAnilistEntityUrl('https://anilist.co/anime/9')!),
    ).toBe('anilist:9');
    expect(
      anilistItemIdFromParsedEntity(
        parseAnilistEntityUrl('https://anilist.co/character/9')!,
      ),
    ).toBe('anilist-character:9');
    expect(
      anilistItemIdFromParsedEntity(parseAnilistEntityUrl('https://anilist.co/staff/9')!),
    ).toBe('anilist-staff:9');
    expect(
      anilistItemIdFromParsedEntity(parseAnilistEntityUrl('https://anilist.co/studio/9')!),
    ).toBe('anilist-studios:9');
  });
});

describe('enrichItemFromAnilistUrl', () => {
  it('attaches source and rewrites slug ids for media URLs', () => {
    const enriched = enrichItemFromAnilistUrl(
      {
        id: 'one-piece',
        label: 'One Piece',
        url: 'anilist.co/anime/21/One-Piece',
      },
      { slugId: 'one-piece' },
    );
    expect(enriched).toEqual({
      id: 'anilist:21',
      label: 'One Piece',
      url: 'https://anilist.co/anime/21',
      source: { kind: 'anilist', externalId: 21 },
    });
  });

  it('preserves explicit ids when preserveId is set', () => {
    const enriched = enrichItemFromAnilistUrl(
      {
        id: 'my-custom-id',
        label: 'One Piece',
        url: 'https://anilist.co/anime/21',
      },
      { preserveId: true, slugId: 'one-piece' },
    );
    expect(enriched.id).toBe('my-custom-id');
    expect(enriched.source).toEqual({ kind: 'anilist', externalId: 21 });
  });

  it('does not overwrite an existing AniList source', () => {
    const item = {
      id: 'anilist:21',
      label: 'One Piece',
      url: 'https://anilist.co/anime/99',
      source: { kind: 'anilist' as const, externalId: 21 },
    };
    expect(enrichItemFromAnilistUrl(item, { slugId: 'one-piece' })).toBe(item);
  });
});

describe('CSV import enrichment', () => {
  it('materializeItemFromRawRow enriches from the URL column', () => {
    const item = materializeItemFromRawRow({
      label: 'Steins;Gate',
      url: 'https://anilist.co/anime/9253',
      sourceName: 'list',
      sourceRow: 1,
    });
    expect(item.id).toBe('anilist:9253');
    expect(item.source).toEqual({ kind: 'anilist', externalId: 9253 });
  });

  it('dedupRows collapses rows that share the same AniList media id', () => {
    const { items } = dedupRows([
      {
        label: 'Fate/stay night',
        url: 'https://anilist.co/anime/169',
        sourceName: 'a',
        sourceRow: 1,
      },
      {
        label: 'FSN (alt spelling)',
        url: 'https://anilist.co/anime/169',
        sourceName: 'b',
        sourceRow: 1,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('anilist:169');
    expect(items[0]?.source).toEqual({ kind: 'anilist', externalId: 169 });
  });
});
