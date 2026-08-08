import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RecentlyDeletedEntity,
} from '../panels/ReorderFavouritesPanel';
import type { FavouriteListItem } from '../panels/reorderFavouritesLogic';

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
  vi.restoreAllMocks();
});

function renderEntity(
  favouriteType: 'ANIME' | 'MANGA' | 'CHARACTERS' | 'STAFF' | 'STUDIOS',
  item: FavouriteListItem,
  onOpenMedia = vi.fn(),
  onOpenStaff = vi.fn(),
): HTMLAnchorElement {
  act(() => {
    root.render(
      <RecentlyDeletedEntity
        favouriteType={favouriteType}
        item={item}
        onOpenMedia={onOpenMedia}
        onOpenStaff={onOpenStaff}
      />,
    );
  });
  const link = container.querySelector('a');
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error('Recently deleted entity did not render a link.');
  }
  return link;
}

function item(label: string): FavouriteListItem {
  return {
    id: 42,
    label,
    imageUrl: 'https://s4.anilist.co/file/anilistcdn/deleted.jpg',
    sortOrder: 0,
  };
}

function expectNativeLinkInteractions(link: HTMLAnchorElement): void {
  const middleDown = new MouseEvent('mousedown', {
    button: 1,
    bubbles: true,
    cancelable: true,
  });
  const middleClick = new MouseEvent('auxclick', {
    button: 1,
    bubbles: true,
    cancelable: true,
  });
  const contextMenu = new MouseEvent('contextmenu', {
    button: 2,
    bubbles: true,
    cancelable: true,
  });

  link.dispatchEvent(middleDown);
  link.dispatchEvent(middleClick);
  link.dispatchEvent(contextMenu);

  expect(middleDown.defaultPrevented).toBe(false);
  expect(middleClick.defaultPrevented).toBe(false);
  expect(contextMenu.defaultPrevented).toBe(false);
}

describe('recently deleted entity links', () => {
  it.each([
    ['ANIME', 'https://anilist.co/anime/42', 'Deleted anime'],
    ['MANGA', 'https://anilist.co/manga/42', 'Deleted manga'],
  ] as const)(
    'renders %s with a thumbnail, native AniList link, and media modal click',
    (favouriteType, expectedUrl, label) => {
      const onOpenMedia = vi.fn();
      const link = renderEntity(
        favouriteType,
        item(label),
        onOpenMedia,
      );

      expect(link.href).toBe(expectedUrl);
      expect(link.querySelector('img')?.src).toBe(
        'https://s4.anilist.co/file/anilistcdn/deleted.jpg',
      );
      act(() => link.click());
      expect(onOpenMedia).toHaveBeenCalledWith(42, label);
      expectNativeLinkInteractions(link);
    },
  );

  it('renders staff with a thumbnail, native AniList link, and staff modal click', () => {
    const onOpenStaff = vi.fn();
    const link = renderEntity(
      'STAFF',
      item('Deleted staff'),
      vi.fn(),
      onOpenStaff,
    );

    expect(link.href).toBe('https://anilist.co/staff/42');
    expect(link.querySelector('img')).not.toBeNull();
    act(() => link.click());
    expect(onOpenStaff).toHaveBeenCalledWith(42, 'Deleted staff');
    expectNativeLinkInteractions(link);
  });

  it.each([
    ['CHARACTERS', 'https://anilist.co/character/42', 'Deleted character'],
    ['STUDIOS', 'https://anilist.co/studio/42', 'Deleted studio'],
  ] as const)(
    'renders %s as a thumbnail and fully native AniList link',
    (favouriteType, expectedUrl, label) => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const link = renderEntity(favouriteType, item(label));

      expect(link.href).toBe(expectedUrl);
      expect(link.querySelector('img')).not.toBeNull();
      act(() => link.click());
      expect(open).toHaveBeenCalledWith(
        expectedUrl,
        '_blank',
        'noopener,noreferrer',
      );
      expectNativeLinkInteractions(link);
    },
  );
});
