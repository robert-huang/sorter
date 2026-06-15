/**
 * PathStepBubble interaction contract:
 *
 *   - In the result screen the bubble is wired with an `onOpenStep`
 *     opener: it renders as a role="button", and left-click / Enter /
 *     Space open the detail modal for that step. Middle-click still
 *     opens the node's AniList page and must NOT also fire the opener.
 *   - During the game no opener is passed, so the bubble has no button
 *     affordance and left-click does nothing (the in-game trail is
 *     non-interactive).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anilistUrlForCharacter, anilistUrlForPathStep } from '../anilistMiddleClick';
import type { PathStep } from '../pathHistory';
import { PathStepBubble, PathTrailEdge } from '../pathStepVisual';

function animeStep(overrides: Partial<Extract<PathStep, { kind: 'anime' }>> = {}): PathStep {
  return {
    kind: 'anime',
    mediaId: 42,
    title: 'Cowboy Bebop',
    coverImage: null,
    ...overrides,
  };
}

function staffStep(overrides: Partial<Extract<PathStep, { kind: 'staff' }>> = {}): PathStep {
  return {
    kind: 'staff',
    staffId: 95011,
    name: 'Megumi Hayashibara',
    image: null,
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

function renderBubble(step: PathStep, onOpenStep?: (step: PathStep) => void): void {
  act(() => {
    root.render(<PathStepBubble step={step} onOpenStep={onOpenStep} />);
  });
}

describe('PathStepBubble interactions', () => {
  it('opens the detail modal on left-click when an opener is wired (result screen)', () => {
    const onOpen = vi.fn();
    renderBubble(animeStep(), onOpen);

    const bubble = container.querySelector('[role="button"]');
    expect(bubble).not.toBeNull();

    act(() => {
      bubble!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(animeStep());
  });

  it('opens the detail modal on Enter / Space for keyboard users', () => {
    const onOpen = vi.fn();
    renderBubble(staffStep(), onOpen);

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    act(() => {
      bubble.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    act(() => {
      bubble.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(staffStep());
  });

  it('middle-click opens AniList and does not also open the modal', () => {
    const onOpen = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const step = animeStep();
    renderBubble(step, onOpen);

    const bubble = container.querySelector('[role="button"]')!;
    act(() => {
      bubble.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      anilistUrlForPathStep(step),
      '_blank',
      'noopener,noreferrer',
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is non-interactive during the game when no opener is passed', () => {
    renderBubble(animeStep());

    // No button affordance: not focusable, no role, click is a no-op.
    expect(container.querySelector('[role="button"]')).toBeNull();
    const bubble = container.querySelector('.anime-to-anime-path-step') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.getAttribute('tabindex')).toBeNull();
    expect(bubble.className).not.toContain('anime-to-anime-path-step--interactive');
  });
});

describe('PathTrailEdge character middle-click', () => {
  it('opens every character page when a voice hop passed through several', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => {
      root.render(
        <PathTrailEdge
          kind="staff"
          viaLabel="as Edward Elric, Alphonse Elric"
          viaCharacters={[
            { id: 11, name: 'Edward Elric' },
            { id: 22, name: 'Alphonse Elric' },
          ]}
        />,
      );
    });

    const edge = container.querySelector('.anime-to-anime-path-edge')!;
    act(() => {
      edge.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });

    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenNthCalledWith(
      1,
      anilistUrlForCharacter(11),
      '_blank',
      'noopener,noreferrer',
    );
    expect(openSpy).toHaveBeenNthCalledWith(
      2,
      anilistUrlForCharacter(22),
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('is inert on middle-click for hops with no characters (staff/relation arrows)', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => {
      root.render(<PathTrailEdge kind="staff" viaLabel="Director" />);
    });

    const edge = container.querySelector('.anime-to-anime-path-edge')!;
    act(() => {
      edge.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });

    expect(openSpy).not.toHaveBeenCalled();
    expect(edge.className).not.toContain('anime-to-anime-anilist-link');
  });
});
