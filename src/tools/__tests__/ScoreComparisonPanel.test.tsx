import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedComparisonList } from '../panels/scoreComparisonApi';
import type { MediaRow } from '../../lib/importers/anilist/types';
import { _clearToolsPreferencesForTesting, saveToolsPreferences } from '../toolsPreferences';

const loadComparisonList = vi.fn();

vi.mock('../panels/scoreComparisonApi', () => ({
  loadComparisonList: (...args: unknown[]) => loadComparisonList(...args),
}));

vi.mock('../../lib/importers/anilist/filters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/filters')>();
  return { ...actual, AnilistChips: () => null };
});

const { ScoreComparisonPanel } = await import('../panels/ScoreComparisonPanel');

function media(id: number, title: string): MediaRow {
  return { id, type: 'ANIME', title_english: title, title_romaji: title, title_native: null, cover_image: null } as MediaRow;
}

function list(name: string, scores: Record<number, number>): LoadedComparisonList {
  const titles: Record<number, string> = { 1: 'Alpha', 2: 'Beta', 3: 'Gamma' };
  return {
    name,
    entries: new Map(Object.entries(scores).map(([id, score]) => [Number(id), { status: 'COMPLETED', score }])),
    media: Object.keys(scores).map((id) => media(Number(id), titles[Number(id)]!)),
    favouriteMediaIds: new Set<number>(),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  _clearToolsPreferencesForTesting();
  localStorage.clear();
  loadComparisonList.mockReset();
  loadComparisonList.mockImplementation(async (username: string) =>
    username.toLowerCase() === 'alice'
      ? list('Alice', { 1: 80, 2: 60 })
      : list('Bob', { 1: 70, 3: 90 }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const onOpenMedia = vi.fn();

async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(<ScoreComparisonPanel onOpenMedia={onOpenMedia} onOpenStaff={vi.fn()} dbSyncRevision={0} />);
  });
}

async function addUser(name: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[name="score-compare-username"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function clickCompare(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Compare')!;
  await act(async () => {
    button.click();
  });
}

async function compareUsers(...names: string[]): Promise<void> {
  for (const name of names) await addUser(name);
  await clickCompare();
}

function bodyRows(): string[][] {
  return [...container.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map(
      (td) => (td.querySelector('.tool-entity-label') ?? td).textContent ?? '',
    ),
  );
}

describe('ScoreComparisonPanel', () => {
  it('loads each added user from the cache and renders one column per user', async () => {
    await renderPanel();
    await compareUsers('Alice', 'Bob');

    expect(loadComparisonList).toHaveBeenCalledWith('Alice', 'ANIME', { forceRefresh: false });
    expect(loadComparisonList).toHaveBeenCalledWith('Bob', 'ANIME', { forceRefresh: false });
    // Empty Min Lists = on every list.
    expect(bodyRows()).toEqual([['Alpha', '75', '80', '70']]);
    expect(container.textContent).toContain('Showing 1 of 3');
  });

  it('waits for Compare before loading, including persisted users', async () => {
    localStorage.setItem('anime-tools-score-comparison-settings', JSON.stringify({ usernames: ['Alice'] }));
    await renderPanel();
    expect(loadComparisonList).not.toHaveBeenCalled();
    expect(container.querySelector('table')).toBeNull();

    await addUser('Bob');
    expect(loadComparisonList).not.toHaveBeenCalled();
    await clickCompare();
    expect(loadComparisonList).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('.tool-score-compare-user-th')).toHaveLength(2);
  });

  it('shows rows on fewer lists once Min Lists is lowered', async () => {
    await renderPanel();
    await compareUsers('Alice', 'Bob');
    const input = container.querySelector<HTMLInputElement>('.tool-score-compare-min-lists')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Default sort: mean desc.
    expect(bodyRows()).toEqual([
      ['Gamma', '90', '', '90'],
      ['Alpha', '75', '80', '70'],
      ['Beta', '60', '60', ''],
    ]);
    expect(container.textContent).toContain('Showing 3 of 3');
  });

  it('refreshes only the clicked column and removes users', async () => {
    await renderPanel();
    await compareUsers('Alice', 'Bob');
    loadComparisonList.mockClear();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Bob\'s list from AniList"]')!.click();
    });
    expect(loadComparisonList).toHaveBeenCalledTimes(1);
    expect(loadComparisonList).toHaveBeenCalledWith('Bob', 'ANIME', { forceRefresh: true });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove Bob"]')!.click();
    });
    expect(container.querySelectorAll('.tool-score-compare-user-th')).toHaveLength(1);
  });

  it('keeps a removed user\'s status selection for when they are re-added', async () => {
    localStorage.setItem(
      'anime-tools-score-comparison-settings',
      JSON.stringify({ usernames: ['Alice'], filters: { userStatuses: { alice: ['DROPPED'] } } }),
    );
    await renderPanel();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove Alice"]')!.click();
    });
    const saved = JSON.parse(localStorage.getItem('anime-tools-score-comparison-settings')!);
    expect(saved.usernames).toEqual([]);
    expect(saved.filters.userStatuses).toEqual({ alice: ['DROPPED'] });
  });

  async function pickStat(label: string): Promise<HTMLElement> {
    const head = container.querySelector<HTMLElement>('.tool-score-compare-stat-head')!;
    await act(async () => {
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const option = [...container.querySelectorAll('.tool-score-compare-stat-menu label')].find(
      (l) => l.textContent === label,
    )!.querySelector('input')!;
    await act(async () => {
      option.click();
    });
    return head;
  }

  it('rescales normalized scores to the gear-menu target and keeps the footer raw', async () => {
    saveToolsPreferences({ scoreComparisonRescale: true });
    await renderPanel();
    await compareUsers('Alice');
    await pickStat('Normalized Mean');
    // Alice: mean 70, std dev 10 → z ±1 → 70 ± 15.
    expect(bodyRows()).toEqual([
      ['Alpha', '85', '85'],
      ['Beta', '55', '55'],
    ]);
    const footer = [...container.querySelectorAll('tfoot tr')].map((tr) => tr.lastElementChild?.textContent);
    expect(footer).toEqual(['70', '10']);
  });

  it('shows raw z-scores by default', async () => {
    await renderPanel();
    await compareUsers('Alice');
    await pickStat('Normalized Mean');
    expect(bodyRows()).toEqual([
      ['Alpha', '1.00', '1.00'],
      ['Beta', '-1.00', '-1.00'],
    ]);
  });

  it('switches the stat from the header right-click menu', async () => {
    await renderPanel();
    await compareUsers('Alice', 'Bob');
    const head = await pickStat('Standard Deviation');
    expect(container.querySelector('.tool-score-compare-stat-menu')).toBeNull();
    expect(head.textContent).toContain('Standard Deviation');
    expect(head.querySelector('button')!.title).toContain('fewer than 2 raters');
    expect(bodyRows().find((row) => row[0] === 'Alpha')![1]).toBe('5');
  });

  it('opens the media modal from the title', async () => {
    await renderPanel();
    await compareUsers('Alice');
    await act(async () => {
      container.querySelector<HTMLElement>('tbody .tool-entity-btn')!.click();
    });
    expect(onOpenMedia).toHaveBeenCalledWith(1, 'Alpha');
  });
});
