import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnilistMiddleClickLink } from '../AnilistMiddleClickLink';
import { FilterChipSelectableOption } from '../filters';

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

describe('AnilistMiddleClickLink', () => {
  it('exposes a native href without default link styling hooks', () => {
    act(() => {
      root.render(
        <AnilistMiddleClickLink
          url="https://anilist.co/anime/1"
          className="custom-link"
        >
          Show
        </AnilistMiddleClickLink>,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('https://anilist.co/anime/1');
    expect(link?.classList.contains('anime-to-anime-anilist-link')).toBe(true);
    expect(link?.classList.contains('custom-link')).toBe(true);
  });

  it('preserves Space activation for targets converted from buttons', () => {
    const onPrimaryClick = vi.fn();
    act(() => {
      root.render(
        <AnilistMiddleClickLink
          url="https://anilist.co/anime/1"
          onPrimaryClick={onPrimaryClick}
        >
          Show
        </AnilistMiddleClickLink>,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a')!;
    const keydown = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => link.dispatchEvent(keydown));

    expect(keydown.defaultPrevented).toBe(true);
    expect(onPrimaryClick).toHaveBeenCalledOnce();
  });

  it('does not bubble modified navigation clicks into parent controls', () => {
    const onParentClick = vi.fn();
    act(() => {
      root.render(
        <div onClick={onParentClick}>
          <AnilistMiddleClickLink url="#show">
            Show
          </AnilistMiddleClickLink>
        </div>,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a')!;
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', {
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe('FilterChipSelectableOption link target', () => {
  it('keeps the checkbox outside the anchor and preserves one plain-click toggle', () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <FilterChipSelectableOption
          checked={false}
          onToggle={onToggle}
          anilistUrl="#show"
        >
          Show
        </FilterChipSelectableOption>,
      );
    });

    expect(container.querySelector('a input')).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>(
      '.filter-chip-option-link-target',
    )!;
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does not toggle the checkbox during modified navigation', () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <FilterChipSelectableOption
          checked={false}
          onToggle={onToggle}
          anilistUrl="#show"
        >
          Show
        </FilterChipSelectableOption>,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>(
      '.filter-chip-option-link-target',
    )!;
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', {
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggles when the option label is clicked outside the checkbox', () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <FilterChipSelectableOption
          checked={false}
          onToggle={onToggle}
          anilistUrl="#show"
        >
          Show
        </FilterChipSelectableOption>,
      );
    });

    const label = container.querySelector<HTMLLabelElement>(
      '.filter-chip-option',
    )!;
    act(() => {
      label.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onToggle).toHaveBeenCalledOnce();
  });
});
