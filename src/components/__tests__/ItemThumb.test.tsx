/**
 * ItemThumb interaction contract:
 *
 *   - AniList media + staff items render as a link-styled anchor. Left-click
 *     opens the detail modal via the ItemDetailContext opener; middle-click
 *     opens the item's canonical AniList page in a new tab and does NOT open
 *     the modal. Right-click exposes the browser link menu via `href`.
 *   - AniList character/studio items render as an anchor with middle-click
 *     only — left-click is a no-op.
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
  it('renders AniList items as a link and opens the detail modal on left-click', () => {
    const opener = vi.fn();
    renderThumb(anilistItem(), opener);

    const link = container.querySelector('a.item-thumb-button');
    expect(link).not.toBeNull();

    act(() => {
      link!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
    });

    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(anilistItem());
  });

  it('exposes AniList href for middle-click and does not open the modal on auxclick', () => {
    const opener = vi.fn();
    renderThumb(anilistItem(), opener);

    const link = container.querySelector('a.item-thumb-button');
    expect(link?.getAttribute('href')).toBe(ANILIST_URL);
    expect(opener).not.toHaveBeenCalled();
  });

  it('keeps opening details when the AniList item has no url', () => {
    const opener = vi.fn();
    const item = anilistItem({ url: undefined });
    renderThumb(item, opener);

    expect(container.querySelector('a.item-thumb-button')).toBeNull();
    const button = container.querySelector('button.item-thumb-button');
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(opener).toHaveBeenCalledWith(item);
  });

  it('renders AniList staff items as a link and opens the panel on left-click', () => {
    const opener = vi.fn();
    renderThumb(staffItem(), opener);

    const link = container.querySelector('a.item-thumb-button');
    expect(link).not.toBeNull();

    act(() => {
      link!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
    });

    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(staffItem());
  });

  it('renders non-AniList items as a plain span with no button affordance', () => {
    const opener = vi.fn();
    renderThumb(manualItem({ url: 'https://example.com/x' }), opener);

    expect(container.querySelector('a.item-thumb-button')).toBeNull();
    expect(container.querySelector('span.thumb')).not.toBeNull();
  });

  it('exposes AniList href for character items and ignores left-click', () => {
    const opener = vi.fn();
    const item = characterItem();
    renderThumb(item, opener);

    expect(container.querySelector('a.item-thumb-button')).toBeNull();
    const thumb = container.querySelector('a.thumb.anime-to-anime-anilist-link');
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute('href')).toBe('https://anilist.co/character/300');

    act(() => {
      thumb!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(opener).not.toHaveBeenCalled();
  });

  it('exposes AniList href for studio favourites without a source tag', () => {
    renderThumb(studioItem(), vi.fn());

    const thumb = container.querySelector('a.thumb.anime-to-anime-anilist-link');
    expect(thumb?.getAttribute('href')).toBe('https://anilist.co/studio/1');
  });
});
