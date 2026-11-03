import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cycleTagMark,
  markTags,
  tagFilterChipLabel,
  TagFilterChip,
  type TagFilterMode,
  type TagSelection,
} from '../filters';

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

const TAGS = ['Gore', 'Iyashikei', 'Time Skip'];
let latest: TagSelection & { tagMode: TagFilterMode; tagMinRank: number };

function Harness() {
  const [state, setState] = useState({
    tagNames: [] as string[],
    tagExclude: [] as string[],
    tagMode: 'or' as TagFilterMode,
    tagMinRank: 0,
  });
  latest = state;
  return (
    <TagFilterChip
      options={TAGS}
      tagNames={state.tagNames}
      tagExclude={state.tagExclude}
      mode={state.tagMode}
      minRank={state.tagMinRank}
      onChange={(patch) => setState((prev) => ({ ...prev, ...patch }))}
    />
  );
}

function open(): void {
  act(() => root.render(<Harness />));
  act(() => container.querySelector<HTMLButtonElement>('.filter-chip-button')?.click());
}

function row(name: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.filter-chip-tristate')].find((el) =>
    el.textContent?.includes(name),
  )!;
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

describe('tag mark helpers', () => {
  const empty: TagSelection = { tagNames: [], tagExclude: [] };

  it('cycles none → include → exclude → none, and back on right-click', () => {
    const included = cycleTagMark(empty, 'Gore', 'forward');
    expect(included).toEqual({ tagNames: ['Gore'], tagExclude: [] });
    const excluded = cycleTagMark(included, 'Gore', 'forward');
    expect(excluded).toEqual({ tagNames: [], tagExclude: ['Gore'] });
    expect(cycleTagMark(excluded, 'Gore', 'forward')).toEqual(empty);
    expect(cycleTagMark(empty, 'Gore', 'back')).toEqual({ tagNames: [], tagExclude: ['Gore'] });
  });

  it('markTags keeps a tag in only one list', () => {
    expect(markTags({ tagNames: ['A'], tagExclude: ['B'] }, ['A', 'B'], 'exclude')).toEqual({
      tagNames: [],
      tagExclude: ['A', 'B'],
    });
  });

  it('only shows label parts that are set', () => {
    expect(tagFilterChipLabel(empty, 'or', 0)).toBe('tag');
    expect(tagFilterChipLabel({ tagNames: ['A', 'B'], tagExclude: ['C'] }, 'or', 0)).toBe('tag · 2 ✓ · 1 ✗');
    expect(tagFilterChipLabel({ tagNames: ['A'], tagExclude: [] }, 'and', 60)).toBe(
      'tag · 1 ✓ · AND, rank ≥ 60',
    );
  });
});

describe('TagFilterChip', () => {
  it('cycles a row on click and steps back on right-click, with include / exclude classes', () => {
    open();
    act(() => row('Gore').click());
    expect(latest.tagNames).toEqual(['Gore']);
    expect(row('Gore').className).toContain('filter-chip-tristate--include');
    act(() => row('Gore').click());
    expect(latest).toMatchObject({ tagNames: [], tagExclude: ['Gore'] });
    expect(row('Gore').className).toContain('filter-chip-tristate--exclude');
    rightClick(row('Gore'));
    expect(latest).toMatchObject({ tagNames: ['Gore'], tagExclude: [] });
    expect(container.querySelector('.filter-chip-button')?.textContent).toBe('tag · 1 ✓');
  });

  it('Select all includes every tag; right-click excludes them; Clear resets both', () => {
    open();
    const selectAll = () =>
      [...container.querySelectorAll<HTMLButtonElement>('.filter-chip-toolbar button')].find(
        (el) => el.textContent === 'Select all',
      )!;
    act(() => selectAll().click());
    expect(latest).toMatchObject({ tagNames: TAGS, tagExclude: [] });
    rightClick(selectAll());
    expect(latest).toMatchObject({ tagNames: [], tagExclude: TAGS });
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('.filter-chip-toolbar button')]
        .find((el) => el.textContent === 'Clear')
        ?.click(),
    );
    expect(latest).toMatchObject({ tagNames: [], tagExclude: [] });
  });

  it('keeps the mode and rank labels in the header', () => {
    open();
    const labels = [...container.querySelectorAll('.filter-chip-range-row > span')].map((el) => el.textContent);
    expect(labels).toEqual(['mode', 'rank ≥']);
  });
});
