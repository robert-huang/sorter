import { describe, expect, it } from 'vitest';
import type { Item } from '../../../types';
import {
  hydrateItemsFromExactAnilistNames,
  normalizeAnilistHydrationName,
  resolveAmbiguousHydration,
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

  it('prefers a real title over another entry using it as a synonym', () => {
    const movie: Item = {
      ...cached('anilist:21519', 'Your Name.'),
      anilistLabelSource: {
        kind: 'media',
        format: 'MOVIE',
        titleFields: {
          id: 21519,
          title_romaji: 'Kimi no Na wa.',
          title_english: 'Your Name.',
          title_native: '君の名は。',
        },
      },
    };
    const tieIn = cached('anilist:97962', 'Suntory Minami Alps no Tennen Mizu', [
      'Kimi no Na wa.',
    ]);
    const result = hydrateItemsFromExactAnilistNames([manual('Kimi no Na wa.')], [tieIn, movie]);
    expect(result.items[0]).toBe(movie);
    expect(result.issues).toEqual([]);
  });

  it('skips rows hydrated by an earlier pass against another list', () => {
    const manga = { ...cached('anilist:72451', 'Horimiya (MANGA)'), url: 'manga' };
    const result = hydrateItemsFromExactAnilistNames(
      [manga, manual('Cowboy Bebop')],
      [cached('anilist:1', 'Cowboy Bebop')],
    );
    expect(result.items[0]).toBe(manga);
    expect(result).toMatchObject({ matchedCount: 1, attemptedCount: 1, issues: [] });
  });

  it('keeps a row manual when its match is already in the list', () => {
    const existing = cached('anilist:1', 'Cowboy Bebop');
    const row = manual('Cowboy Bebop');
    const result = hydrateItemsFromExactAnilistNames([existing, row], [existing]);
    expect(result.items[1]).toBe(row);
    expect(result.issues).toEqual([
      {
        index: 1,
        itemId: row.id,
        label: 'Cowboy Bebop',
        reason: 'duplicate_candidate',
        conflicts: ['Cowboy Bebop'],
      },
    ]);
  });

  it('names the other row claiming the same entry through a synonym', () => {
    const entry = cached('anilist:1', 'Happy Sugar Life', ['White Sugar Garden']);
    const rows = [manual('Happy Sugar Life'), manual('White Sugar Garden')];
    const result = hydrateItemsFromExactAnilistNames(rows, [entry]);
    expect(result.issues.map((i) => i.conflicts)).toEqual([
      ['White Sugar Garden'],
      ['Happy Sugar Life'],
    ]);
  });

  it('offers tied synonym matches for a manual pick and applies it', () => {
    const one = cached('anilist:1', 'One', ['Shared']);
    const two = cached('anilist:2', 'Two', ['Shared']);
    const rows = [manual('Shared'), manual('Shared', 'manual:other')];
    const result = hydrateItemsFromExactAnilistNames(rows, [one, two]);
    expect(result.issues.map((issue) => issue.candidates)).toEqual([[one, two], [one, two]]);

    const picked = resolveAmbiguousHydration(result, rows, result.issues[0]!, two)!;
    expect(picked.items).toEqual([two, rows[1]]);
    expect(picked.matchedCount).toBe(1);
    // The other row can no longer take the entry that's now in the list.
    expect(picked.issues).toEqual([{ ...result.issues[1]!, candidates: [one] }]);
  });

  it('finds rows by id after the caller re-dedupes the list', () => {
    const one = cached('anilist:1', 'One', ['Shared']);
    const two = cached('anilist:2', 'Two', ['Shared']);
    const bebop = cached('anilist:5', 'Cowboy Bebop');
    const rows = [manual('Cowboy Bebop'), manual('bebop again', 'manual:dupe'), manual('Shared')];
    const result = hydrateItemsFromExactAnilistNames(rows, [one, two, bebop]);
    expect(result.issues.find((i) => i.reason === 'ambiguous_alias')?.index).toBe(2);

    // The caller merged a row after hydrating, so "Shared" moved up one.
    const current = [bebop, rows[2]!];
    const ambiguous = result.issues.find((i) => i.reason === 'ambiguous_alias')!;
    const picked = resolveAmbiguousHydration(result, current, ambiguous, one)!;
    expect(picked.items).toEqual([bebop, one]);
  });

  it('ignores a pick for a row edited since matching', () => {
    const result = hydrateItemsFromExactAnilistNames(
      [manual('Shared')],
      [cached('anilist:1', 'One', ['Shared']), cached('anilist:2', 'Two', ['Shared'])],
    );
    const edited = [manual('Something else')];
    expect(
      resolveAmbiguousHydration(result, edited, result.issues[0]!, result.issues[0]!.candidates![0]!),
    ).toBeNull();
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
