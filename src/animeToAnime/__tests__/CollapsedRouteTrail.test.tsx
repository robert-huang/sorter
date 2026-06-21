/**
 * CollapsedRouteTrail slot-selection contract:
 *
 *   A route's intermediate "slot" holds several interchangeable shows. Picking
 *   a different show must (1) swap the slot bubble's label and (2) re-derive
 *   BOTH arrows around the slot — the incoming `sPrev→show` edge and the
 *   outgoing `show→sNext` edge that labels the following staff hop — so the
 *   trail always reflects a concrete, valid shortest path.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollapsedRoute } from '../cachedGraph';
import { CollapsedRouteTrail } from '../CollapsedRouteTrail';

function twoOptionRoute(): CollapsedRoute {
  return {
    linksUsed: 2,
    items: [
      { kind: 'fixed', step: { kind: 'anime', mediaId: 1, title: 'Start', coverImage: null } },
      {
        kind: 'fixed',
        step: { kind: 'staff', staffId: 10, name: 'VA One', image: null, viaLabel: 'VA start' },
      },
      {
        kind: 'slot',
        options: [
          {
            show: { kind: 'anime', mediaId: 2, title: 'Show A', coverImage: null, viaLabel: 'as Hero A' },
            nextStaffVia: { viaLabel: 'as Villain A' },
          },
          {
            show: { kind: 'anime', mediaId: 3, title: 'Show B', coverImage: null, viaLabel: 'as Hero B' },
            nextStaffVia: { viaLabel: 'as Villain B' },
          },
        ],
      },
      {
        kind: 'fixed',
        step: { kind: 'staff', staffId: 11, name: 'VA Two', image: null, viaLabel: 'as Villain A' },
      },
      { kind: 'fixed', step: { kind: 'anime', mediaId: 4, title: 'Goal', coverImage: null, viaLabel: 'VA goal' } },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function edgeTitles(): (string | null)[] {
  return [...container.querySelectorAll('.anime-to-anime-path-edge')].map((edge) =>
    edge.getAttribute('title'),
  );
}

function labels(): string[] {
  return [...container.querySelectorAll('.anime-to-anime-win-path-label')].map(
    (node) => node.textContent ?? '',
  );
}

describe('CollapsedRouteTrail slot selection', () => {
  it('swaps the slot bubble and re-derives both adjacent arrows', () => {
    // Pin the random default to the first option for a deterministic baseline.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    act(() => {
      root.render(<CollapsedRouteTrail route={twoOptionRoute()} />);
    });

    // Four arrows: start→s1, s1→slot, slot→s2, s2→goal.
    expect(edgeTitles()).toEqual(['VA start', 'as Hero A', 'as Villain A', 'VA goal']);
    expect(labels()).toContain('Show A');
    expect(labels()).not.toContain('Show B');

    const caret = container.querySelector('.anime-to-anime-slot-caret') as HTMLElement;
    expect(caret).not.toBeNull();
    expect(caret.textContent).toBe('+1');

    // Open the slot menu and pick the second show.
    act(() => {
      caret.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const menuItems = container.querySelectorAll('.anime-to-anime-slot-menu-item');
    expect(menuItems).toHaveLength(2);
    act(() => {
      menuItems[1].dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

    // Bubble label and BOTH flanking arrows now reflect Show B.
    expect(labels()).toContain('Show B');
    expect(labels()).not.toContain('Show A');
    expect(edgeTitles()).toEqual(['VA start', 'as Hero B', 'as Villain B', 'VA goal']);
  });

  it('defaults a slot to a random option (not the first by title)', () => {
    // 0.99 → floor(0.99 × 2) = 1 → second option (Show B).
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    act(() => {
      root.render(<CollapsedRouteTrail route={twoOptionRoute()} />);
    });

    expect(labels()).toContain('Show B');
    expect(labels()).not.toContain('Show A');
    expect(edgeTitles()).toEqual(['VA start', 'as Hero B', 'as Villain B', 'VA goal']);
  });

  it('opens the picker from a left-click on the slot title', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    act(() => {
      root.render(<CollapsedRouteTrail route={twoOptionRoute()} />);
    });

    expect(container.querySelector('.anime-to-anime-slot-menu')).toBeNull();
    const title = container.querySelector('.anime-to-anime-slot-title') as HTMLElement;
    expect(title).not.toBeNull();
    expect(title.textContent).toBe('Show A');

    act(() => {
      title.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(container.querySelectorAll('.anime-to-anime-slot-menu-item')).toHaveLength(2);
  });

  it('opens the alternate-links menu upward when the slot is near the page bottom', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains('anime-to-anime-slot')) {
        return {
          top: 800,
          bottom: 840,
          left: 100,
          right: 300,
          width: 200,
          height: 40,
          x: 100,
          y: 800,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBoundingClientRect.call(this);
    };
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    });

    try {
      act(() => {
        root.render(<CollapsedRouteTrail route={twoOptionRoute()} />);
      });
      const caret = container.querySelector('.anime-to-anime-slot-caret') as HTMLElement;
      act(() => {
        caret.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(container.querySelector('.anime-to-anime-slot-menu--up')).not.toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGetBoundingClientRect;
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: window.innerHeight,
      });
    }
  });

  it('renders a single-option route with no slot picker', () => {
    const route: CollapsedRoute = {
      linksUsed: 1,
      items: [
        { kind: 'fixed', step: { kind: 'anime', mediaId: 1, title: 'Start', coverImage: null } },
        {
          kind: 'fixed',
          step: { kind: 'staff', staffId: 10, name: 'VA One', image: null, viaLabel: 'as Hero' },
        },
        { kind: 'fixed', step: { kind: 'anime', mediaId: 2, title: 'Goal', coverImage: null, viaLabel: 'as Hero' } },
      ],
    };
    act(() => {
      root.render(<CollapsedRouteTrail route={route} />);
    });
    expect(container.querySelector('.anime-to-anime-slot-caret')).toBeNull();
    expect(labels()).toEqual(['Start', 'VA One', 'Goal']);
  });
});
