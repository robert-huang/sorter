import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../toolsSessionMemo';
import {
  persistentCacheDeletePrefix,
  persistentCacheGet,
  persistentCacheSet,
} from '../toolsPersistentCache';
import {
  TOOLS_MEDIA_RELATIONS_CACHE_PREFIX,
  fetchToolsMediaRelationsCached,
} from '../toolsMediaRelationsApi';

vi.mock('../transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

import { executeAnilistQuery } from '../transport';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);

beforeEach(() => {
  _clearSessionMemoForTesting();
  persistentCacheDeletePrefix('franchise:relations:');
  persistentCacheDeletePrefix('adaptation:relations:');
  persistentCacheDeletePrefix(TOOLS_MEDIA_RELATIONS_CACHE_PREFIX);
  executeAnilistQueryMock.mockReset();
});

describe('fetchToolsMediaRelationsCached', () => {
  it('prunes legacy per-tool relation cache keys on first fetch', async () => {
    persistentCacheSet('franchise:relations:10', { media: { id: 10 }, edges: [] }, 60_000);
    persistentCacheSet('adaptation:relations:20', { media: { id: 20 }, edges: [] }, 60_000);

    executeAnilistQueryMock.mockResolvedValue({
      Media: {
        id: 99,
        title: { english: 'Show', romaji: null, native: null },
        relations: { edges: [] },
      },
    });

    await fetchToolsMediaRelationsCached(99);

    expect(persistentCacheGet('franchise:relations:10')).toEqual({ hit: false });
    expect(persistentCacheGet('adaptation:relations:20')).toEqual({ hit: false });
    expect(persistentCacheGet(`${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}99`)).toMatchObject({
      hit: true,
    });
  });
});
