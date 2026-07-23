import { describe, expect, it } from 'vitest';
import {
  buildAniplaylistSearchParams,
  ANIPLAYLIST_HITS_PER_PAGE,
  ANIPLAYLIST_LOCAL_PROXY_PATH,
  resolveAniplaylistSearchUrl,
} from '../themeSongs/aniplaylistApi';

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
  it('uses the local Vite proxy path in dev', () => {
    expect(resolveAniplaylistSearchUrl()).toBe(ANIPLAYLIST_LOCAL_PROXY_PATH);
  });
});
