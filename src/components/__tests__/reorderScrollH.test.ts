import { afterEach, describe, expect, it, vi } from 'vitest';
import { reorderKeepingControlPosition } from '../reorderScrollH';

function rect(left: number, top: number): DOMRect {
  return {
    left,
    top,
    right: left + 20,
    bottom: top + 20,
    width: 20,
    height: 20,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function translateY(element: HTMLElement): number {
  const match = element.style.transform.match(
    /^translate\([^,]+,\s*(-?[\d.]+)px\)/,
  );
  return Number(match?.[1]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('reorderKeepingControlPosition', () => {
  it('offsets the page by the control movement after a reorder', () => {
    const control = document.createElement('button');
    document.body.appendChild(control);
    let reordered = false;
    vi.spyOn(control, 'getBoundingClientRect').mockImplementation(() =>
      reordered ? rect(40, 130) : rect(40, 200),
    );
    const scrollBy = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation(() => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    reorderKeepingControlPosition(control, () => {
      reordered = true;
    });

    expect(scrollBy).toHaveBeenCalledWith(0, -70);
  });

  it('offsets a supplied list scroller instead of the page', () => {
    const scroller = document.createElement('div');
    const control = document.createElement('button');
    scroller.appendChild(control);
    document.body.appendChild(scroller);
    scroller.scrollLeft = 5;
    scroller.scrollTop = 30;
    let reordered = false;
    vi.spyOn(control, 'getBoundingClientRect').mockImplementation(() =>
      reordered ? rect(75, 170) : rect(50, 120),
    );
    const pageScroll = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation(() => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    reorderKeepingControlPosition(
      control,
      () => {
        reordered = true;
      },
      { scrollContainer: scroller },
    );

    expect(scroller.scrollLeft).toBe(30);
    expect(scroller.scrollTop).toBe(80);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('can follow a replacement control when a stable slot keeps its DOM node', () => {
    const original = document.createElement('button');
    const moved = document.createElement('button');
    document.body.append(original, moved);
    vi.spyOn(original, 'getBoundingClientRect').mockReturnValue(rect(30, 200));
    vi.spyOn(moved, 'getBoundingClientRect').mockReturnValue(rect(30, 90));
    const focus = vi.spyOn(moved, 'focus').mockImplementation(() => undefined);
    const scrollBy = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation(() => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    reorderKeepingControlPosition(original, vi.fn(), {
      resolveControl: () => moved,
    });

    expect(scrollBy).toHaveBeenCalledWith(0, -110);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('synchronizes the swap animation with the page scroll', () => {
    const container = document.createElement('div');
    const source = document.createElement('div');
    const target = document.createElement('div');
    const control = document.createElement('button');
    source.className = 'queue-item-row';
    target.className = 'queue-item-row';
    source.appendChild(control);
    container.append(source, target);
    document.body.appendChild(container);
    let reordered = false;
    let scrolledTop = 0;
    vi.spyOn(control, 'getBoundingClientRect').mockImplementation(() =>
      rect(20, (reordered ? 150 : 100) - scrolledTop),
    );
    vi.spyOn(source, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, reordered ? 160 : 100),
    );
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, reordered ? 100 : 150),
    );
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation((_x, y) => {
      scrolledTop += Number(y);
    });
    const frames: FrameRequestCallback[] = [];
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      frameId += 1;
      return frameId;
    });

    reorderKeepingControlPosition(
      control,
      () => {
        reordered = true;
      },
      { direction: 1 },
    );

    frames.shift()?.(0);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(source.style.transform).toBe('translate(0px, -50px)');
    expect(source.style.zIndex).toBe('1');
    expect(target.style.transform).toBe('translate(0px, 50px)');
    frames.shift()?.(80);
    expect(scrolledTop).toBeGreaterThan(0);
    expect(scrolledTop).toBeLessThan(50);
    expect(-translateY(source) + scrolledTop).toBeCloseTo(50);
    frames.shift()?.(160);
    expect(scrolledTop).toBeCloseTo(50);
    expect(source.style.transform).toBe('');
    expect(source.style.zIndex).toBe('');
    expect(target.style.transform).toBe('');
  });

  it('settles an interrupted transition without losing the pointer anchor', () => {
    const container = document.createElement('div');
    const source = document.createElement('div');
    const target = document.createElement('div');
    const control = document.createElement('button');
    source.className = 'queue-item-row';
    target.className = 'queue-item-row';
    source.appendChild(control);
    container.append(source, target);
    document.body.appendChild(container);
    let reordered = false;
    let scrolledTop = 0;
    vi.spyOn(control, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, (reordered ? 150 : 100) - scrolledTop),
    );
    vi.spyOn(source, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, reordered ? 150 : 100),
    );
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, reordered ? 100 : 150),
    );
    vi.spyOn(window, 'scrollBy').mockImplementation((_x, y) => {
      scrolledTop += Number(y);
    });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    const runFrame = (id: number, time: number): void => {
      const callback = frames.get(id);
      frames.delete(id);
      callback?.(time);
    };

    reorderKeepingControlPosition(
      control,
      () => {
        reordered = true;
      },
      { direction: 1 },
    );
    runFrame(1, 0);
    runFrame(2, 80);
    expect(scrolledTop).toBeGreaterThan(0);
    expect(scrolledTop).toBeLessThan(50);

    reorderKeepingControlPosition(control, vi.fn());

    expect(scrolledTop).toBeCloseTo(50);
    expect(control.getBoundingClientRect().top).toBeCloseTo(100);
    expect(source.style.transform).toBe('');
    expect(source.style.zIndex).toBe('');
    expect(target.style.transform).toBe('');
  });

  it('uses instant control anchoring when reduced motion is requested', () => {
    const row = document.createElement('div');
    const control = document.createElement('button');
    row.className = 'queue-item-row';
    row.appendChild(control);
    document.body.appendChild(row);
    vi.spyOn(control, 'getBoundingClientRect')
      .mockReturnValueOnce(rect(0, 40))
      .mockReturnValue(rect(0, 0));
    vi.spyOn(row, 'getBoundingClientRect')
      .mockReturnValueOnce(rect(0, 40))
      .mockReturnValue(rect(0, 0));
    const scrollBy = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    reorderKeepingControlPosition(control, vi.fn(), {
      animationPairs: [{ beforeElement: row }],
    });

    expect(row.style.transform).toBe('');
    expect(scrollBy).toHaveBeenCalledWith(0, -40);
  });
});
