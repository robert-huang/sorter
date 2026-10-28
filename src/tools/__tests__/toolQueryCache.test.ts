import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import { _resetPersistentToolsCacheForTesting } from '../../lib/importers/anilist/toolsPersistentCache';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import {
  readCachedQueryMatch,
  resolveQueryMatch,
  showQueryKey,
  staffQueryKey,
  type QueryMatch,
} from '../toolQueryCache';
import { mergeStagedQueries, normalizeStagedQueries, pendingQueries } from '../ToolQueryStaging';

const MATCH: QueryMatch = { id: 1, title: 'Steins;Gate', coverImage: null };

beforeEach(async () => {
  localStorage.clear();
  await _resetDisposableCacheDbForTesting();
  _resetPersistentToolsCacheForTesting();
  _clearSessionMemoForTesting();
});

describe('query keys', () => {
  it('normalizes case and whitespace and keys shows by sort', () => {
    expect(showQueryKey('  Steins;Gate ', true)).toBe(showQueryKey('steins;gate', true));
    expect(showQueryKey('steins;gate', true)).not.toBe(showQueryKey('steins;gate', false));
    expect(staffQueryKey('Kana Hanazawa')).toBe('shared-credits:query:kana hanazawa');
  });
});

describe('resolveQueryMatch', () => {
  it('reports new until resolved, then serves the cached match', async () => {
    const key = showQueryKey('steins;gate', true);
    await expect(readCachedQueryMatch(key)).resolves.toBeNull();

    const search = vi.fn(async () => MATCH);
    await expect(resolveQueryMatch(key, search)).resolves.toEqual(MATCH);
    _clearSessionMemoForTesting();
    await expect(resolveQueryMatch(key, search)).resolves.toEqual(MATCH);
    expect(search).toHaveBeenCalledTimes(1);
    await expect(readCachedQueryMatch(key)).resolves.toEqual(MATCH);
  });

  it('re-searches on force refresh', async () => {
    const key = staffQueryKey('kana');
    await resolveQueryMatch(key, async () => MATCH);
    const next = { ...MATCH, id: 2 };
    await expect(
      resolveQueryMatch(key, async () => next, { forceRefresh: true }),
    ).resolves.toEqual(next);
    await expect(readCachedQueryMatch(key)).resolves.toEqual(next);
  });

  it('does not cache failed searches', async () => {
    const key = staffQueryKey('nobody');
    await expect(
      resolveQueryMatch(key, async () => {
        throw new Error('not found');
      }),
    ).rejects.toThrow('not found');
    await expect(readCachedQueryMatch(key)).resolves.toBeNull();
  });
});

describe('resolveStaffIds', () => {
  it('keeps repeated people so each query gets its own column', async () => {
    const { resolveStaffIds } = await import('../panels/sharedCreditsApi');
    await expect(resolveStaffIds(['5', '6', '5'], true)).resolves.toEqual([5, 6, 5]);
  });
});

describe('staged query helpers', () => {
  it('merges without case-insensitive duplicates', () => {
    expect(mergeStagedQueries(['Steins;Gate'], ['steins;gate', 'Your Name'])).toEqual([
      'Steins;Gate',
      'Your Name',
    ]);
    expect(pendingQueries(['Steins;Gate'], ['STEINS;GATE', 'Your Name'])).toEqual(['Your Name']);
    expect(normalizeStagedQueries([' A ', 'a', 3, '', 'B'])).toEqual(['A', 'B']);
    expect(normalizeStagedQueries('junk')).toEqual([]);
  });
});
