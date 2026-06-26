import { describe, expect, it } from 'vitest';
import {
  captureLeftmostVisibleScrollAnchor,
  isYearOnlyScrollAnchorKey,
  parseScrollAnchorYear,
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

describe('parseScrollAnchorYear', () => {
  it('parses year-only and season labels', () => {
    expect(parseScrollAnchorYear('2026')).toBe(2026);
    expect(parseScrollAnchorYear('Fall 2026')).toBe(2026);
  });

  it('detects year-only anchor keys', () => {
    expect(isYearOnlyScrollAnchorKey('2026')).toBe(true);
    expect(isYearOnlyScrollAnchorKey('Fall 2026')).toBe(false);
  });
});

describe('scrollAnchor', () => {
  it('captures the leftmost partially visible anchored child', () => {
    const container = document.createElement('div');
    const spring = document.createElement('div');
    spring.setAttribute('data-scroll-anchor', 'Spring 2020');
    spring.setAttribute('data-scroll-anchor-year', '2020');
    spring.getBoundingClientRect = () => mockRect(40, 120);
    const summer = document.createElement('div');
    summer.setAttribute('data-scroll-anchor', 'Summer 2020');
    summer.setAttribute('data-scroll-anchor-year', '2020');
    summer.getBoundingClientRect = () => mockRect(180, 120);
    container.appendChild(spring);
    container.appendChild(summer);
    container.getBoundingClientRect = () => mockRect(0, 400);

    expect(
      captureLeftmostVisibleScrollAnchor(container, '[data-scroll-anchor]'),
    ).toEqual({
      key: 'Spring 2020',
      offsetInViewport: 40,
      year: 2020,
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
    anchor.setAttribute('data-scroll-anchor-year', '2021');
    anchor.getBoundingClientRect = () => mockRect(220, 120);
    container.appendChild(anchor);

    const restored = restoreScrollAnchor(container, '[data-scroll-anchor]', {
      key: 'Fall 2021',
      offsetInViewport: 60,
      year: 2021,
    });

    expect(restored).toBe(true);
    expect(container.scrollLeft).toBe(160);
  });

  it('falls back from a season column to the matching year column', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => mockRect(0, 400);
    Object.defineProperty(container, 'scrollLeft', {
      writable: true,
      value: 0,
    });

    const year = document.createElement('div');
    year.setAttribute('data-scroll-anchor', '2026');
    year.setAttribute('data-scroll-anchor-year', '2026');
    year.getBoundingClientRect = () => mockRect(180, 200);
    container.appendChild(year);

    const restored = restoreScrollAnchor(container, '[data-scroll-anchor]', {
      key: 'Fall 2026',
      offsetInViewport: 40,
      year: 2026,
    });

    expect(restored).toBe(true);
    expect(container.scrollLeft).toBe(140);
  });

  it('falls back from a year column to the first season column for that year', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => mockRect(0, 400);
    Object.defineProperty(container, 'scrollLeft', {
      writable: true,
      value: 0,
    });

    const winter = document.createElement('div');
    winter.setAttribute('data-scroll-anchor', 'Winter 2026');
    winter.setAttribute('data-scroll-anchor-year', '2026');
    winter.getBoundingClientRect = () => mockRect(100, 120);
    const spring = document.createElement('div');
    spring.setAttribute('data-scroll-anchor', 'Spring 2026');
    spring.setAttribute('data-scroll-anchor-year', '2026');
    spring.getBoundingClientRect = () => mockRect(240, 120);
    container.appendChild(winter);
    container.appendChild(spring);

    const restored = restoreScrollAnchor(container, '[data-scroll-anchor]', {
      key: '2026',
      offsetInViewport: 30,
      year: 2026,
    });

    expect(restored).toBe(true);
    expect(container.scrollLeft).toBe(70);
  });

  it('returns false when the anchor column no longer exists', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => mockRect(0, 400);

    expect(
      restoreScrollAnchor(container, '[data-scroll-anchor]', {
        key: 'Winter 2019',
        offsetInViewport: 20,
        year: 2019,
      }),
    ).toBe(false);
  });
});
