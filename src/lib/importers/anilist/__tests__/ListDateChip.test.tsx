import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListDateChip } from '../filters';
import { encodeListMonth, type ListDateFilterState } from '../listDateFilter';

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
});

const OPTIONS = [
  encodeListMonth(2021, 1),
  encodeListMonth(2022, 6),
  encodeListMonth(2023, 3),
  encodeListMonth(2024, 9),
];

function renderOpen(
  value: Partial<ListDateFilterState>,
  extra: {
    mode?: 'any' | 'all';
    onModeChange?: (mode: 'any' | 'all') => void;
    mediaType?: 'ANIME' | 'MANGA';
  } = {},
) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <ListDateChip
        options={OPTIONS}
        value={{ listDateField: 'active', listDateMin: null, listDateMax: null, ...value }}
        onChange={onChange}
        {...extra}
      />,
    );
  });
  act(() => {
    container.querySelector<HTMLButtonElement>('.filter-chip-button')?.click();
  });
  const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]');
  return { onChange, lo: sliders[0]!, hi: sliders[1]! };
}

function drag(slider: HTMLInputElement, value: string): void {
  act(() => {
    slider.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(slider: HTMLInputElement, key: string): void {
  act(() => {
    slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ListDateChip', () => {
  it('runs the slider over option indices with full-width rows and no mode row by default', () => {
    const { lo, hi } = renderOpen({});
    expect(lo.max).toBe('3');
    expect(lo.value).toBe('0');
    expect(hi.value).toBe('3');
    const labels = [...container.querySelectorAll('.filter-chip-segmented-fill button')].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(['Active', 'Started', 'Finished']);
    expect(container.querySelector('.filter-chip-range-row > span')).toBeNull();
    expect(container.textContent).not.toContain('Clear');
  });

  it('shows One person / Everyone first when a mode is passed', () => {
    const onModeChange = vi.fn();
    renderOpen({}, { mode: 'any', onModeChange });
    const labels = [...container.querySelectorAll('.filter-chip-segmented-fill button')].map(
      (button) => button.textContent,
    );
    expect(labels.slice(0, 2)).toEqual(['One person', 'Everyone']);
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Everyone')
        ?.click();
    });
    expect(onModeChange).toHaveBeenCalledWith('all');
  });

  it('lets a handle be dragged past its partner, swapping start and end', () => {
    const { onChange, lo } = renderOpen({ listDateMin: OPTIONS[1]!, listDateMax: OPTIONS[2]! });
    drag(lo, '3');
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: OPTIONS[2], listDateMax: null });
  });

  it('steps each handle with the arrow keys, collapsing slider edges to open bounds', () => {
    const { onChange, lo, hi } = renderOpen({ listDateMin: OPTIONS[1]!, listDateMax: OPTIONS[2]! });
    press(hi, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: OPTIONS[1], listDateMax: null });
    press(lo, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: null, listDateMax: OPTIONS[2] });
    press(lo, 'ArrowRight');
    press(lo, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: OPTIONS[2], listDateMax: OPTIONS[2] });
  });

  it('parks the start handle at the end when the typed start is after every option', () => {
    const { lo, hi } = renderOpen({ listDateMin: encodeListMonth(2025, 1) });
    expect(lo.value).toBe('3');
    expect(hi.value).toBe('3');
  });

  it('puts Clear range on its own row under the slider and labels the chip', () => {
    const { onChange } = renderOpen({ listDateField: 'started', listDateMin: OPTIONS[1]!, listDateMax: null });
    expect(container.querySelector('.filter-chip-button')?.textContent).toBe('watch dates · started ≥ June 2022');
    expect(container.querySelector('.filter-chip-slider-row .filter-chip-action')).toBeNull();
    const clear = container.querySelector<HTMLButtonElement>('.filter-chip-slider-labels + .filter-chip-action');
    expect(clear?.textContent).toBe('Clear range');
    act(() => clear?.click());
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: null, listDateMax: null });
  });

  it('is named "read dates" for manga and shows the completed field as finished', () => {
    renderOpen({ listDateField: 'completed', listDateMax: OPTIONS[2]! }, { mediaType: 'MANGA' });
    expect(container.querySelector('.filter-chip-button')?.textContent).toBe('read dates · finished ≤ March 2023');
  });

  it('shows the year in the boxes and the months under the slider', () => {
    renderOpen({ listDateMin: OPTIONS[1]!, listDateMax: OPTIONS[2]! });
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    expect([...boxes].map((box) => box.value)).toEqual(['2022', '2023']);
    const labels = [...container.querySelectorAll('.filter-chip-slider-labels span')].map((s) => s.textContent);
    expect(labels).toEqual(['June 2022', 'March 2023']);
  });

  it.each(['202310', '2023/10', '2023-10'])('reads %s as October 2023 and keeps the box at the year', (typed) => {
    const { onChange } = renderOpen({});
    const box = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, typed);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      box.focus();
      box.blur();
    });
    expect(onChange).toHaveBeenLastCalledWith({ listDateMin: encodeListMonth(2023, 10), listDateMax: null });
    expect(box.value).toBe('2023');
  });

  it('keeps the month when the box is left on the same year', () => {
    const { onChange } = renderOpen({ listDateMin: OPTIONS[1]! });
    const box = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      box.focus();
      box.blur();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(box.value).toBe('2022');
  });

  it('steps a box one calendar month with the arrow keys', () => {
    const { onChange } = renderOpen({ listDateMin: OPTIONS[1]!, listDateMax: OPTIONS[2]! });
    const [from, to] = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    act(() => {
      from!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({
      listDateMin: encodeListMonth(2022, 7),
      listDateMax: OPTIONS[2],
    });
    act(() => {
      to!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({
      listDateMin: OPTIONS[1],
      listDateMax: encodeListMonth(2023, 2),
    });
  });
});
