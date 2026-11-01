import { describe, expect, it } from 'vitest';
import {
  applySorterStagedGroupEdit,
  applyStartScreenHydration,
  editHydrationIssueRow,
} from '../StartScreen';
import type { StagedGroup } from '../StagedItemsPanel';

describe('StartScreen staged item editing', () => {
  it('opens the editor on the source row behind an unmatched issue', () => {
    const opened: Array<[string, number]> = [];
    const openEdit = editHydrationIssueRow(
      [
        { sourceName: 'a', items: [{ item: { id: 'one', label: 'One' }, sourceRow: 1 }] },
        { sourceName: 'b', items: [{ item: { id: 'two', label: 'Two' }, sourceRow: 4 }] },
      ],
      (sourceName, rowNumber) => opened.push([sourceName, rowNumber]),
    );
    openEdit({ index: 1, itemId: 'two', label: 'Two', reason: 'unmatched' });
    openEdit({ index: 2, itemId: 'gone', label: 'Gone', reason: 'unmatched' });
    expect(opened).toEqual([['b', 4]]);
  });

  it('applies exact hydration to the initial import preview', () => {
    const manual = { id: 'cached-title', label: 'cached title' };
    const hydrated = {
      id: 'anilist:123',
      label: 'Cached title',
      url: 'https://anilist.co/anime/123',
      source: { kind: 'anilist' as const, externalId: 123 },
    };
    const overrides = applyStartScreenHydration(
      new Map(),
      [manual],
      [
        {
          sourceName: 'pasted CSV',
          items: [{ item: manual, sourceRow: 1 }],
        },
      ],
      {
        items: [hydrated],
        matchedCount: 1,
        attemptedCount: 1,
        issues: [],
      },
    );

    expect(overrides.get('pasted CSV:1')).toEqual({
      replacement: hydrated,
      id: hydrated.id,
      label: hydrated.label,
      url: hydrated.url,
      imageUrl: '',
    });
  });

  it('hydrates a canonical id and rewrites staged removal markers', () => {
    const group: StagedGroup = {
      kind: 'flat',
      id: 'group-1',
      source: 'Manual',
      items: [{ id: 'manual', label: 'Manual title' }],
      markedItemIds: new Set(['manual']),
    };
    const hydrated = {
      id: 'anilist:123',
      label: 'Cached title',
      url: 'https://anilist.co/anime/123',
      imageUrl: 'https://example.com/123.jpg',
      source: { kind: 'anilist' as const, externalId: 123 },
      searchTokens: ['Cached title', 'English title'],
    };

    const updated = applySorterStagedGroupEdit(group, 'manual', {
      id: hydrated.id,
      hydratedItem: hydrated,
      url: 'https://example.com/explicit',
    });

    expect(updated.items).toEqual([
      {
        ...hydrated,
        url: 'https://example.com/explicit',
      },
    ]);
    expect(Array.from(updated.markedItemIds ?? [])).toEqual([hydrated.id]);
  });
});
