import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedCreditsResultsTable } from '../panels/sharedCreditsTable';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SharedCreditsResultsTable favourite annotations', () => {
  it('annotates staff, rowspan media, and character names before role labels', () => {
    act(() => {
      root.render(
        <SharedCreditsResultsTable
          staffIds={[2]}
          staffNames={['Favourite Staff']}
          staffImages={[null]}
          rows={[
            {
              mediaId: 1,
              title: 'Favourite Show',
              coverImage: null,
              cells: [
                [
                  { label: 'Favourite Character (MAIN)', characterId: 3 },
                  { label: 'Other Character (SUPPORTING)', characterId: 4 },
                ],
              ],
            },
          ]}
          favourites={{
            mediaIds: new Set([1]),
            characterIds: new Set([3]),
            staffIds: new Set([2]),
            studioIds: new Set<number>(),
          }}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('thead .anilist-detail-person-link--favourite')?.textContent)
      .toBe('Favourite Staff ★');
    const showHeader = container.querySelector<HTMLTableCellElement>(
      'tbody th.tool-credits-col-show',
    );
    expect(showHeader?.rowSpan).toBe(2);
    expect(showHeader?.querySelector('.anilist-detail-media-title--favourite')?.textContent)
      .toBe('Favourite Show ★');
    expect(
      container.querySelector('.anilist-detail-character-name--favourite')?.textContent,
    ).toBe('Favourite Character ★ (MAIN)');
    expect(container.textContent).toContain('Other Character (SUPPORTING)');
    expect(container.textContent).not.toContain('Other Character ★');
  });
});
