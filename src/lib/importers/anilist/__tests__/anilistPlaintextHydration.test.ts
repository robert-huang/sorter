import { describe, expect, it } from 'vitest';
import type { Item } from '../../../types';
import {
  hydrateItemsFromExactAnilistNames,
  normalizeAnilistHydrationName,
} from '../anilistPlaintextHydration';

function manual(label: string, id = `manual:${label}`): Item {
  return { id, label };
}

function cached(id: string, label: string, aliases: string[] = []): Item {
  return {
    id,
    label,
    searchTokens: aliases,
    source: { kind: 'anilist', externalId: Number(id.split(':')[1]) },
  };
}

describe('AniList plaintext hydration', () => {
  it('normalizes Unicode compatibility, case, and whitespace runs only', () => {
    expect(normalizeAnilistHydrationName('  ＡLICE\n  Smith  ')).toBe(
      'alice smith',
    );
    expect(normalizeAnilistHydrationName('Renée!')).not.toBe(
      normalizeAnilistHydrationName('Renee'),
    );
  });

  it('hydrates a unique exact alias with complete cached metadata', () => {
    const candidate = {
      ...cached('anilist:1', 'Cowboy Bebop', ['カウボーイビバップ']),
      url: 'https://anilist.co/anime/1',
      imageUrl: 'cover.jpg',
    };
    const result = hydrateItemsFromExactAnilistNames(
      [manual('  COWBOY\nBEBOP ')],
      [candidate],
    );
    expect(result.matchedCount).toBe(1);
    expect(result.items[0]).toEqual(candidate);
    expect(result.issues).toEqual([]);
  });

  it('preserves ambiguous aliases and duplicate claims as manual rows', () => {
    const first = manual('Shared', 'manual:first');
    const second = manual('Shared', 'manual:second');
    const ambiguous = hydrateItemsFromExactAnilistNames(
      [first],
      [
        cached('anilist:1', 'One', ['Shared']),
        cached('anilist:2', 'Two', ['Shared']),
      ],
    );
    expect(ambiguous.items[0]).toBe(first);
    expect(ambiguous.issues[0]?.reason).toBe('ambiguous_alias');

    const duplicate = hydrateItemsFromExactAnilistNames(
      [first, second],
      [cached('anilist:1', 'Shared')],
    );
    expect(duplicate.items).toEqual([first, second]);
    expect(duplicate.issues.map((issue) => issue.reason)).toEqual([
      'duplicate_candidate',
      'duplicate_candidate',
    ]);
  });

  it('leaves unmatched rows unchanged', () => {
    const input = manual('Not cached');
    const result = hydrateItemsFromExactAnilistNames(
      [input],
      [cached('anilist:1', 'Other')],
    );
    expect(result.items[0]).toBe(input);
    expect(result.issues[0]?.reason).toBe('unmatched');
  });
});
