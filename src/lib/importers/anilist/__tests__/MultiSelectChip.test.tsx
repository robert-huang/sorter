import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiSelectChip } from '../filters';

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

function chipIsActive(selected: string[], allSelectedFilters?: boolean, emptyFilters?: boolean): boolean {
  act(() => {
    root.render(
      <MultiSelectChip<string>
        label="format"
        options={['TV', 'MOVIE']}
        selected={selected}
        onToggle={vi.fn()}
        allSelectedFilters={allSelectedFilters}
        emptyFilters={emptyFilters}
      />,
    );
  });
  return container.querySelector('.filter-chip')!.classList.contains('active');
}

describe('MultiSelectChip highlight', () => {
  it('highlights only a partial selection', () => {
    expect(chipIsActive([])).toBe(false);
    expect(chipIsActive(['TV'])).toBe(true);
    expect(chipIsActive(['TV', 'MOVIE'])).toBe(false);
  });

  it('keeps an all-selected chip highlighted when selecting everything still filters', () => {
    expect(chipIsActive(['TV', 'MOVIE'], true)).toBe(true);
  });

  it('highlights an empty chip when selecting nothing hides everything', () => {
    expect(chipIsActive([], false, true)).toBe(true);
  });
});
