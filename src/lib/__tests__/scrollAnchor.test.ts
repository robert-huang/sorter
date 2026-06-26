import { describe, expect, it } from 'vitest';
import {
  captureLeftmostVisibleScrollAnchor,
  restoreScrollAnchor,
} from '../scrollAnchor';

function mockRect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 100,
    width,
    height: 100,
    x: left,
    y: 0,
    toJSON() {
      return {};
    },
  };
}

describe('scrollAnchor', () => {
  it('captures the leftmost partially visible anchored child', () => {
    const container = document.createElement('div');
    const spring = document.createElement('div');
    spring.setAttribute('data-scroll-anchor', 'Spring 2020');
    spring.getBoundingClientRect = () => mockRect(40, 120);
    const summer = document.createElement('div');
    summer.setAttribute('data-scroll-anchor', 'Summer 2020');
    summer.getBoundingClientRect = () => mockRect(180, 120);
    container.appendChild(spring);
    container.appendChild(summer);
    container.getBoundingClientRect = () => mockRect(0, 400);

    expect(
      captureLeftmostVisibleScrollAnchor(container, '[data-scroll-anchor]'),
    ).toEqual({
      key: 'Spring 2020',
      offsetInViewport: 40,
    });
  });

  it('restores scroll so the anchor returns to its saved viewport offset', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => mockRect(0, 400);
    Object.defineProperty(container, 'scrollLeft', {
      writable: true,
      value: 0,
    });

    const anchor = document.createElement('div');
    anchor.setAttribute('data-scroll-anchor', 'Fall 2021');
    anchor.getBoundingClientRect = () => mockRect(220, 120);
    container.appendChild(anchor);

    const restored = restoreScrollAnchor(
      container,
      '[data-scroll-anchor]',
      { key: 'Fall 2021', offsetInViewport: 60 },
    );

    expect(restored).toBe(true);
    expect(container.scrollLeft).toBe(160);
  });

  it('returns false when the anchor column no longer exists', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => mockRect(0, 400);

    expect(
      restoreScrollAnchor(container, '[data-scroll-anchor]', {
        key: 'Winter 2019',
        offsetInViewport: 20,
      }),
    ).toBe(false);
  });
});
