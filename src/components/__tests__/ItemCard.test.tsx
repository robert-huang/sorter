import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';
import { ItemCard, REMOVE_ITEM_TOOLTIP } from '../ItemCard';

const item: Item = {
  id: 'AAAAAAAAAAAAAQ',
  label: 'Cowboy Bebop',
  url: 'https://anilist.co/anime/1',
  source: { kind: 'anilist', externalId: 1 },
};

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

describe('ItemCard link target', () => {
  it('exposes the card URL as a native link without changing plain left-click', () => {
    const onPick = vi.fn();
    act(() => {
      root.render(<ItemCard item={item} onPick={onPick} />);
    });

    const link = container.querySelector<HTMLAnchorElement>('.item-card-link-target');
    expect(link?.getAttribute('href')).toBe(item.url);

    act(() => {
      link!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onPick).toHaveBeenCalledOnce();
  });

  it('does not add a whole-card link when the card is disabled', () => {
    act(() => {
      root.render(<ItemCard item={item} disabled />);
    });

    expect(container.querySelector('.item-card-link-target')).toBeNull();
  });

  it('explains and handles both ranked and unranked removal actions', () => {
    const onRemove = vi.fn();
    act(() => {
      root.render(<ItemCard item={item} onRemove={onRemove} />);
    });

    const removeButton = container.querySelector<HTMLButtonElement>('.remove-btn');
    expect(removeButton?.title).toBe(REMOVE_ITEM_TOOLTIP);

    act(() => removeButton?.click());
    expect(onRemove).toHaveBeenCalledWith();
    onRemove.mockClear();

    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      removeButton?.dispatchEvent(contextMenu);
    });

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(onRemove).toHaveBeenCalledWith(true);
  });
});
