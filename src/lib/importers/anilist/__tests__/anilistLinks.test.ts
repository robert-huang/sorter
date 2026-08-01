import { describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import {
  anilistUrlForSeasonSearch,
  bindAnilistMiddleClick,
  composeAnilistLinkClick,
  isModifiedAnilistNavigationClick,
} from '../anilistLinks';

describe('bindAnilistMiddleClick', () => {
  it('returns href for single-URL targets', () => {
    const link = bindAnilistMiddleClick('https://anilist.co/anime/1');
    expect(link.href).toBe('https://anilist.co/anime/1');
    expect(link.className).toBe('anime-to-anime-anilist-link');
  });

  it('does not cancel native middle-click for a single URL', () => {
    const link = bindAnilistMiddleClick('https://anilist.co/anime/1');
    const mouseDownPreventDefault = vi.fn();
    const auxClickPreventDefault = vi.fn();
    const auxClickStopPropagation = vi.fn();

    link.onMouseDown({
      button: 1,
      preventDefault: mouseDownPreventDefault,
    } as unknown as MouseEvent<HTMLElement>);
    link.onAuxClick({
      button: 1,
      preventDefault: auxClickPreventDefault,
      stopPropagation: auxClickStopPropagation,
    } as unknown as MouseEvent<HTMLElement>);

    expect(mouseDownPreventDefault).not.toHaveBeenCalled();
    expect(auxClickPreventDefault).not.toHaveBeenCalled();
    expect(auxClickStopPropagation).not.toHaveBeenCalled();
  });

  it('returns first href when multiple URLs are supplied', () => {
    const link = bindAnilistMiddleClick([
      'https://anilist.co/character/1',
      'https://anilist.co/character/2',
    ]);
    expect(link.href).toBe('https://anilist.co/character/1');
  });

  it('opens every URL on middle-click when multiple are supplied', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const link = bindAnilistMiddleClick([
      'https://anilist.co/character/1',
      'https://anilist.co/character/2',
    ]);
    link.onAuxClick({
      button: 1,
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent<HTMLElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledTimes(2);
    openSpy.mockRestore();
  });
});

describe('composeAnilistLinkClick', () => {
  it('runs the primary handler for plain left-click', () => {
    const primary = vi.fn();
    const handler = composeAnilistLinkClick(primary);
    const event = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent<HTMLElement>;

    handler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(primary).toHaveBeenCalledWith(event);
  });

  it('does not run the primary handler for modified clicks', () => {
    const primary = vi.fn();
    const handler = composeAnilistLinkClick(primary);
    handler({
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent<HTMLElement>);

    expect(primary).not.toHaveBeenCalled();
  });

  it('can preserve an explicit shift-click primary action', () => {
    const primary = vi.fn();
    const handler = composeAnilistLinkClick(primary, { allowShiftKey: true });
    const event = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent<HTMLElement>;

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(primary).toHaveBeenCalledWith(event);
  });

  it('keeps combined shift modifiers as native navigation', () => {
    const primary = vi.fn();
    const handler = composeAnilistLinkClick(primary, { allowShiftKey: true });
    const event = {
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent<HTMLElement>;

    handler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
  });
});

describe('isModifiedAnilistNavigationClick', () => {
  it('detects ctrl/cmd/shift/alt navigation clicks', () => {
    expect(
      isModifiedAnilistNavigationClick({
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as MouseEvent),
    ).toBe(true);
  });
});

describe('anilistUrlForSeasonSearch', () => {
  it('builds a year+season URL with "only show my anime" pre-checked', () => {
    expect(anilistUrlForSeasonSearch('FALL', 2020)).toBe(
      'https://anilist.co/search/anime?year=2020&season=FALL&only%20show%20my%20anime=true',
    );
  });

  it('omits season when null (full-year column from `all`)', () => {
    expect(anilistUrlForSeasonSearch(null, 2020)).toBe(
      'https://anilist.co/search/anime?year=2020&only%20show%20my%20anime=true',
    );
  });

  it('upper-cases the season token (handles `allseasons` lowercase output)', () => {
    expect(anilistUrlForSeasonSearch('winter', 2024)).toContain('season=WINTER');
  });

  it('uses %20 (not +) for spaces in the toggle key so AniList parses it', () => {
    const url = anilistUrlForSeasonSearch(null, 2024);
    expect(url).toContain('only%20show%20my%20anime=true');
    expect(url).not.toContain('+');
  });

  it('omits year for all-time list search links', () => {
    expect(anilistUrlForSeasonSearch(null, 0)).toBe(
      'https://anilist.co/search/anime?only%20show%20my%20anime=true',
    );
  });
});
