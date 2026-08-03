import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeSeasonYear,
  seasonYearOptionsForSelectedYears,
  SeasonYearChip,
} from '../filters';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
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

describe('SeasonYearChip', () => {
  it('maps sparse selected years to consecutive slider indices', () => {
    const onChange = vi.fn();
    const options = seasonYearOptionsForSelectedYears(
      [],
      [2021, 2025, 2026],
    );
    act(() => {
      root.render(
        <SeasonYearChip
          options={options}
          min={null}
          max={null}
          onChange={onChange}
        />,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('.filter-chip-button')?.click();
    });

    const sliders = container.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    );
    expect(sliders).toHaveLength(2);
    expect(sliders[0]?.min).toBe('0');
    expect(sliders[0]?.max).toBe('11');
    expect(sliders[0]?.value).toBe('0');
    expect(sliders[1]?.value).toBe('11');
    expect(container.textContent).toContain('Winter 2021');
    expect(container.textContent).toContain('Fall 2026');

    act(() => {
      const minimum = sliders[0]!;
      minimum.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(minimum, '4');
      minimum.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith({
      seasonYearMin: encodeSeasonYear('WINTER', 2025),
      seasonYearMax: null,
    });
  });
});
