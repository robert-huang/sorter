import { describe, expect, it } from 'vitest';
import {
  buildAniplaylistSearchParams,
  ANIPLAYLIST_HITS_PER_PAGE,
  ANIPLAYLIST_LOCAL_PROXY_PATH,
  isAniplaylistRemoteProxyUrl,
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
