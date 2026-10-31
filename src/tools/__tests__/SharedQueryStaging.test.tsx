import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import {
  _resetPersistentToolsCacheForTesting,
  persistentCacheSet,
} from '../../lib/importers/anilist/toolsPersistentCache';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { QUERY_MATCH_TTL_MS, showQueryKey, staffQueryKey } from '../toolQueryCache';
import { textWithUnstagedQueries } from '../ToolQueryStaging';

const runSharedStaffCompare = vi.fn();
const searchAnimeShow = vi.fn();
const resolveStaffIds = vi.fn();
const resolveStaffQuery = vi.fn();
const runSharedCreditsCompare = vi.fn();

vi.mock('../panels/sharedStaffApi', () => ({
  runSharedStaffCompare: (...args: unknown[]) => runSharedStaffCompare(...args),
  searchAnimeShow: (...args: unknown[]) => searchAnimeShow(...args),
}));

vi.mock('../panels/sharedCreditsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/sharedCreditsApi')>();
  return {
    ...actual,
    resolveStaffIds: (...args: unknown[]) => resolveStaffIds(...args),
    resolveStaffQuery: (...args: unknown[]) => resolveStaffQuery(...args),
    runSharedCreditsCompare: (...args: unknown[]) => runSharedCreditsCompare(...args),
  };
});

vi.mock('../useCurrentAnilistFavourites', () => ({
  useCurrentAnilistFavourites: () => ({
    mediaIds: new Set<number>(),
    studioIds: new Set<number>(),
    staffIds: new Set<number>(),
    characterIds: new Set<number>(),
  }),
}));

const { SharedStaffPanel } = await import('../panels/SharedStaffPanel');
const { SharedCreditsPanel } = await import('../panels/SharedCreditsPanel');

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

beforeEach(async () => {
  localStorage.clear();
  await _resetDisposableCacheDbForTesting();
  _resetPersistentToolsCacheForTesting();
  _clearSessionMemoForTesting();
  for (const mock of [
    runSharedStaffCompare,
    searchAnimeShow,
    resolveStaffIds,
    resolveStaffQuery,
    runSharedCreditsCompare,
  ]) {
    mock.mockReset();
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

function rows(): Array<{ query: string; match: string; pending: boolean }> {
  return [...container.querySelectorAll('.tool-query-staging-row')].map((row) => ({
    query: row.querySelector('.tool-query-staging-query')?.textContent ?? '',
    match:
      row.querySelector('.tool-query-staging-match .tool-entity-label')?.textContent ??
      row.querySelector('.tool-query-staging-match')?.textContent ??
      '',
    pending: row.classList.contains('pending'),
  }));
}

const panelProps = { onOpenMedia: vi.fn(), onOpenStaff: vi.fn(), dbSyncRevision: 0 };

describe('textWithUnstagedQueries', () => {
  it('puts staged queries first and skips textarea duplicates', () => {
    expect(
      textWithUnstagedQueries(['Steins;Gate', 'Your Name'], ['your name', 'Mob Psycho']),
    ).toBe('Steins;Gate\nYour Name\nMob Psycho');
  });
});

describe('Shared Staff staged queries', () => {
  async function render(): Promise<void> {
    await act(async () => {
      root.render(<SharedStaffPanel {...panelProps} />);
    });
    await flush();
  }

  it('shows pending lines, stages them without duplicates, and reads cached matches', async () => {
    await persistentCacheSet(
      showQueryKey('steins;gate', true),
      { id: 1, title: 'Steins;Gate', coverImage: null },
      QUERY_MATCH_TTL_MS,
    );
    await render();
    const textarea = container.querySelector('textarea')!;
    await typeInto(textarea, 'Steins;Gate\nYour Name\nsteins;gate');
    expect(rows()).toEqual([
      { query: 'Steins;Gate', match: 'Steins;Gate', pending: true },
      { query: 'Your Name', match: 'new', pending: true },
    ]);

    await click(button('Add to staged'));
    expect(textarea.value).toBe('');
    expect(rows().map((row) => row.pending)).toEqual([false, false]);
    const saved = JSON.parse(localStorage.getItem('anime-tools-shared-staff-form')!);
    expect(saved.stagedQueries).toEqual(['Steins;Gate', 'Your Name']);
    expect(searchAnimeShow).not.toHaveBeenCalled();
  });

  it('compares staged plus pending queries and fills in new rows', async () => {
    localStorage.setItem(
      'anime-tools-shared-staff-form',
      JSON.stringify({ stagedQueries: ['Your Name'], showText: 'Steins;Gate' }),
    );
    runSharedStaffCompare.mockImplementation(
      async (options: {
        showSearches: string[];
        onResolved: (q: string, m: unknown) => void;
      }) => {
        options.showSearches.forEach((query, index) =>
          options.onResolved(query, { id: index + 1, title: `Match ${query}`, coverImage: null }),
        );
        return { shows: [] };
      },
    );
    await render();
    expect(rows().map((row) => row.match)).toEqual(['new', 'new']);

    await click(button('Compare'));
    expect(runSharedStaffCompare.mock.calls[0]![0].showSearches).toEqual([
      'Your Name',
      'Steins;Gate',
    ]);
    expect(rows().map((row) => row.match)).toEqual(['Match Your Name', 'Match Steins;Gate']);
    expect(rows().map((row) => row.pending)).toEqual([false, false]);
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  it('refreshes only the clicked row', async () => {
    localStorage.setItem(
      'anime-tools-shared-staff-form',
      JSON.stringify({ stagedQueries: ['Your Name', 'Steins;Gate'] }),
    );
    searchAnimeShow.mockResolvedValue({ id: 9, title: 'Kimi no Na wa', coverImage: null });
    await render();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Your Name"]')!);
    expect(searchAnimeShow).toHaveBeenCalledTimes(1);
    expect(searchAnimeShow).toHaveBeenCalledWith('Your Name', true, undefined, { forceRefresh: true });
    expect(rows().map((row) => row.match)).toEqual(['Kimi no Na wa', 'new']);

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Remove Steins;Gate"]')!);
    expect(rows().map((row) => row.query)).toEqual(['Your Name']);
  });
});

describe('Shared Credits staged queries', () => {
  it('reads cached staff matches and passes staged plus pending queries to Compare', async () => {
    await persistentCacheSet(
      staffQueryKey('kana hanazawa'),
      { id: 5, title: 'Kana Hanazawa', coverImage: null },
      QUERY_MATCH_TTL_MS,
    );
    localStorage.setItem(
      'anime-tools-shared-credits-form',
      JSON.stringify({ stagedQueries: ['Kana Hanazawa'], staffText: 'Yuki Kaji' }),
    );
    resolveStaffIds.mockResolvedValue([5, 6]);
    runSharedCreditsCompare.mockResolvedValue({
      staffNameFields: {},
      lists: [],
      userMediaIds: null,
      usernameMode: null,
    });
    await act(async () => {
      root.render(<SharedCreditsPanel {...panelProps} />);
    });
    await flush();

    expect(rows()).toEqual([
      { query: 'Kana Hanazawa', match: 'Kana Hanazawa', pending: false },
      { query: 'Yuki Kaji', match: 'new', pending: true },
    ]);
    await click(button('Compare'));
    expect(resolveStaffIds.mock.calls[0]![0]).toEqual(['Kana Hanazawa', 'Yuki Kaji']);
    expect(rows().map((row) => row.pending)).toEqual([false, false]);
  });
});
