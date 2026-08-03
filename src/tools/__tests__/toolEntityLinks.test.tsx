import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFavouriteStarBeforeRole,
  ToolCharacterName,
  ToolShowButton,
  ToolStaffButton,
  ToolStudioName,
} from '../toolEntityLinks';

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

describe('tool entity favourite annotations', () => {
  it('appends stars directly and applies entity-specific favourite classes', () => {
    act(() => {
      root.render(
        <>
          <ToolShowButton
            mediaId={1}
            title="Favourite Show"
            onOpenMedia={vi.fn()}
            favourite
          />
          <ToolStaffButton
            staffId={2}
            name="Favourite Staff"
            onOpenStaff={vi.fn()}
            favourite
          />
          <ToolCharacterName characterId={3} name="Favourite Character" favourite />
          <ToolStudioName studioId={4} name="Favourite Studio" favourite />
        </>,
      );
    });

    expect(container.querySelector('.anilist-detail-media-title--favourite')?.textContent)
      .toBe('Favourite Show ★');
    expect(container.querySelector('.anilist-detail-person-link--favourite')?.textContent)
      .toBe('Favourite Staff ★');
    expect(container.querySelector('.anilist-detail-character-name--favourite')?.textContent)
      .toBe('Favourite Character ★');
    expect(container.querySelector('.anilist-detail-tag-item-studio--favourite')?.textContent)
      .toBe('Favourite Studio ★');
    expect(container.querySelectorAll('[class*="favourite-star"]')).toHaveLength(0);
  });

  it('keeps the star before a trailing character role', () => {
    expect(appendFavouriteStarBeforeRole('Character Name (MAIN)', true)).toBe(
      'Character Name ★ (MAIN)',
    );
    expect(appendFavouriteStarBeforeRole('Production', false)).toBe('Production');
  });
});
