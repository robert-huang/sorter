import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffCompareSectionTable } from '../panels/SharedStaffPanel';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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

describe('StaffCompareSectionTable favourite annotations', () => {
  it('annotates show headers and studio, staff, VA, and character rows', () => {
    act(() => {
      root.render(
        <StaffCompareSectionTable
          section={{
            title: 'Shared entities',
            rows: [
              {
                entityId: 2,
                name: 'Favourite Studio',
                kind: 'studio',
                cells: ['yes'],
              },
              {
                entityId: 3,
                name: 'Favourite Staff',
                kind: 'staff',
                cells: ['Director'],
              },
              {
                entityId: 4,
                name: 'Favourite VA',
                kind: 'va',
                cells: ['Favourite Character (MAIN)'],
                characterIds: [5],
              },
            ],
          }}
          shows={[{ id: 1, title: 'Favourite Show', coverImage: null }]}
          favourites={{
            mediaIds: new Set([1]),
            studioIds: new Set([2]),
            staffIds: new Set([3, 4]),
            characterIds: new Set([5]),
          }}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.anilist-detail-media-title--favourite')?.textContent)
      .toBe('Favourite Show ★');
    expect(container.querySelector('.anilist-detail-tag-item-studio--favourite')?.textContent)
      .toBe('Favourite Studio ★');
    expect(
      Array.from(
        container.querySelectorAll('.anilist-detail-person-link--favourite'),
      ).map((element) => element.textContent),
    ).toEqual(['Favourite Staff ★', 'Favourite VA ★']);
    expect(container.querySelector('.anilist-detail-character-name--favourite')?.textContent)
      .toBe('Favourite Character ★ (MAIN)');
  });
});
