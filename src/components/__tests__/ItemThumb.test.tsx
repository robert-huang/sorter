/**
 * ItemThumb interaction contract:
 *
 *   - AniList media + staff items render as a button. Left-click opens the
 *     detail modal via the ItemDetailContext opener; middle-click
 *     (auxclick, button 1) opens the item's canonical AniList page in
 *     a new tab and does NOT open the modal.
 *   - AniList character/studio items (url on anilist.co, no detail panel)
 *     render as a span with middle-click only — left-click is a no-op.
 *   - Other items (manual entries, non-AniList urls) render a plain span
 *     with no interaction wiring.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';
import { ItemDetailContext, type ItemDetailOpener } from '../itemDetailContext';
import { ItemThumb } from '../ItemThumb';

const ANILIST_URL = 'https://anilist.co/anime/42';

function anilistItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'AAAAAAAAAAAAAg',
    label: 'Cowboy Bebop',
    url: ANILIST_URL,
    source: { kind: 'anilist', externalId: 42 },
    ...overrides,
  };
}

function staffItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'QQQQQQQQQQQQQg',
    label: 'Megumi Hayashibara',
    url: 'https://anilist.co/staff/95011',
    source: { kind: 'anilist-staff', externalId: 95011 },
    ...overrides,
  };
}

function manualItem(overrides: Partial<Item> = {}): Item {
  return { id: 'BBBBBBBBBBBBBg', label: 'Manual entry', ...overrides };
}

function characterItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'anilist-character:300',
    label: 'Spike Spiegel',
    url: 'https://anilist.co/character/300',
    source: { kind: 'anilist-character', externalId: 300 },
    ...overrides,
  };
}

function studioItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'anilist-studios:1',
    label: 'Bones',
    url: 'https://anilist.co/studio/1',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 18 act() requires this opt-in flag in non-RTL test envs.
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

function renderThumb(item: Item, opener: ItemDetailOpener | null): void {
  act(() => {
    root.render(
      <ItemDetailContext.Provider value={opener}>
        <ItemThumb item={item} className="thumb" />
      </ItemDetailContext.Provider>,
    );
  });
}

describe('ItemThumb interactions', () => {
  it('renders AniList items as a button and opens the detail modal on left-click', () => {
    const opener = vi.fn();
    renderThumb(anilistItem(), opener);

    const button = container.querySelector('button.item-thumb-button');
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      );
    });

    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(anilistItem());
  });

  it('opens the AniList page in a new tab on middle-click and does not open the modal', () => {
    const opener = vi.fn();
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderThumb(anilistItem(), opener);

    const button = container.querySelector('button.item-thumb-button');
    act(() => {
      button!.dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      );
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      ANILIST_URL,
      '_blank',
      'noopener,noreferrer',
    );
    // Middle-click must not also fire the left-click modal opener.
    expect(opener).not.toHaveBeenCalled();
  });

  it('ignores middle-click when the AniList item has no url', () => {
    const opener = vi.fn();
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderThumb(anilistItem({ url: undefined }), opener);

    const button = container.querySelector('button.item-thumb-button');
    act(() => {
      button!.dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      );
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('renders AniList staff items as a button and opens the panel on left-click', () => {
    const opener = vi.fn();
    renderThumb(staffItem(), opener);

    const button = container.querySelector('button.item-thumb-button');
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(staffItem());
  });

  it('renders non-AniList items as a plain span with no button affordance', () => {
    const opener = vi.fn();
    renderThumb(manualItem({ url: 'https://example.com/x' }), opener);

    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('span.thumb')).not.toBeNull();
  });

  it('opens AniList on middle-click for character items and ignores left-click', () => {
    const opener = vi.fn();
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    const item = characterItem();
    renderThumb(item, opener);

    expect(container.querySelector('button')).toBeNull();
    const thumb = container.querySelector('span.thumb.anime-to-anime-anilist-link');
    expect(thumb).not.toBeNull();

    act(() => {
      thumb!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(opener).not.toHaveBeenCalled();

    act(() => {
      thumb!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://anilist.co/character/300',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens AniList on middle-click for studio favourites without a source tag', () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderThumb(studioItem(), vi.fn());

    const thumb = container.querySelector('span.thumb.anime-to-anime-anilist-link');
    act(() => {
      thumb!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });

    expect(openSpy).toHaveBeenCalledWith(
      'https://anilist.co/studio/1',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
