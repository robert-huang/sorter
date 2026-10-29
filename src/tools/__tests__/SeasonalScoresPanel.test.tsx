import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSeasonYear } from '../../lib/importers/anilist/filters';
import { SeasonalScoresPanel } from '../panels/SeasonalScoresPanel';
import { _clearToolsPreferencesForTesting } from '../toolsPreferences';
import type { SeasonalShow } from '../panels/seasonalScoresLogic';

const fetchUserSeasonalShows = vi.fn();

vi.mock('../panels/seasonalScoresApi', () => ({
  fetchUserSeasonalShows: (...args: unknown[]) => fetchUserSeasonalShows(...args),
  bustSeasonalSessionMemo: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  localStorage.clear();
  _clearToolsPreferencesForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SeasonalScoresPanel notes filter', () => {
  it('persists custom text and resets it after toggling the filter off', () => {
    act(() => {
      root.render(
        <SeasonalScoresPanel
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
          dbSyncRevision={0}
        />,
      );
    });

    let notesLabel = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Notes filter'),
    );
    let checkbox = notesLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    expect(container.textContent).not.toContain('Span airing seasons');

    act(() => checkbox?.click());
    let notesInput = container.querySelector<HTMLInputElement>(
      '.tool-seasonal-notes-filter-input',
    );
    expect(notesInput?.value).toBe('#airing');

    act(() => {
      if (notesInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(notesInput, '#watching');
        notesInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    expect(
      JSON.parse(
        localStorage.getItem('anime-tools-seasonal-scores-form') ?? '{}',
      ).notesFilter,
    ).toBe('#watching');

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(
        <SeasonalScoresPanel
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
          dbSyncRevision={0}
        />,
      );
    });
    notesLabel = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Notes filter'),
    );
    checkbox = notesLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('.tool-seasonal-notes-filter-input')
        ?.value,
    ).toBe('#watching');

    act(() => checkbox?.click());
    expect(container.querySelector('.tool-seasonal-notes-filter-input')).toBeNull();

    act(() => checkbox?.click());
    notesInput = container.querySelector<HTMLInputElement>(
      '.tool-seasonal-notes-filter-input',
    );
    expect(notesInput?.value).toBe('#airing');
    expect(
      JSON.parse(
        localStorage.getItem('anime-tools-seasonal-scores-form') ?? '{}',
      ).airingNotesOnly,
    ).toBe(true);
  });
});

function renderPanel(): void {
  act(() => {
    root.render(
      <SeasonalScoresPanel onOpenMedia={vi.fn()} onOpenStaff={vi.fn()} dbSyncRevision={0} />,
    );
  });
}

function planningCheckbox(): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((el) =>
    el.textContent?.includes('Include Planning'),
  );
  return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function persistedListStatuses(): unknown {
  return JSON.parse(localStorage.getItem('anime-tools-seasonal-scores-primary-filters') ?? '{}')
    .listStatuses;
}

describe('SeasonalScoresPanel users and planning', () => {
  it('migrates a saved single username and includePlanning', () => {
    localStorage.setItem(
      'anime-tools-seasonal-scores-form',
      JSON.stringify({ username: 'alice', includePlanning: true }),
    );
    renderPanel();
    expect(container.querySelector('.tool-user-chip')?.textContent).toContain('alice');
    expect(planningCheckbox().checked).toBe(true);
    expect(persistedListStatuses()).toContain('PLANNING');
    const savedForm = JSON.parse(localStorage.getItem('anime-tools-seasonal-scores-form') ?? '{}');
    expect(savedForm.usernames).toEqual(['alice']);
    expect(savedForm.includePlanning).toBeUndefined();
  });

  it('keeps Include Planning and the PLANNING list status in sync', () => {
    localStorage.setItem(
      'anime-tools-seasonal-scores-primary-filters',
      JSON.stringify({ listStatuses: ['COMPLETED', 'PLANNING'] }),
    );
    renderPanel();
    expect(planningCheckbox().checked).toBe(true);

    act(() => planningCheckbox().click());
    expect(planningCheckbox().checked).toBe(false);
    expect(persistedListStatuses()).toEqual(['COMPLETED']);

    act(() => planningCheckbox().click());
    expect(persistedListStatuses()).toEqual(['COMPLETED', 'PLANNING']);
  });

  it('averages scores across users and clears the chart when a user is removed', async () => {
    const show = (id: number, score: number | null, listStatus = 'COMPLETED'): SeasonalShow => ({
      id,
      title: `Show ${id}`,
      season: 'WINTER',
      seasonYear: 2024,
      score,
      notes: null,
      listStatus,
    });
    fetchUserSeasonalShows.mockImplementation(async (username: string) =>
      username === 'alice' ? [show(1, 80)] : [show(1, 91), show(2, null, 'CURRENT')],
    );
    localStorage.setItem(
      'anime-tools-seasonal-scores-form',
      JSON.stringify({ usernames: ['alice', 'bob'], seasonMode: 'custom', seasonText: 'Winter 2024' }),
    );
    renderPanel();

    const compare = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Compare',
    )!;
    await act(async () => {
      compare.click();
    });

    expect(fetchUserSeasonalShows.mock.calls.map((call) => call[0])).toEqual(['alice', 'bob']);
    const scores = Array.from(container.querySelectorAll<HTMLElement>('.tool-season-score'));
    expect(scores.map((el) => el.textContent)).toEqual(['85.5', 'W']);
    expect(scores[0]!.title).toBe('2 completed, 2 rated, 0 watching, 0 planning\nalice: 80\nbob: 91');

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove bob"]')!.click();
    });
    expect(container.querySelector('.tool-season-score')).toBeNull();
  });
});

describe('SeasonalScoresPanel year filters', () => {
  it('restores sparse years and gives seasonYear one step per allowed season', () => {
    localStorage.setItem(
      'anime-tools-seasonal-scores-primary-filters',
      JSON.stringify({
        years: [2021, 2025, 2026],
        seasonYearMin: encodeSeasonYear('SPRING', 2021),
        seasonYearMax: encodeSeasonYear('SUMMER', 2026),
        listStatuses: ['COMPLETED', 'CURRENT', 'REPEATING', 'PAUSED'],
      }),
    );

    act(() => {
      root.render(
        <SeasonalScoresPanel
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
          dbSyncRevision={0}
        />,
      );
    });

    const seasonYearButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.filter-chip-button'),
    ).find((button) => button.textContent?.startsWith('seasonYear'));
    expect(seasonYearButton).toBeTruthy();
    act(() => seasonYearButton?.click());

    const minimumSlider = container.querySelector<HTMLInputElement>(
      'input[aria-label="season-year range minimum"]',
    );
    expect(minimumSlider?.min).toBe('0');
    expect(minimumSlider?.max).toBe('11');
    expect(minimumSlider?.value).toBe('1');

    const persisted = JSON.parse(
      localStorage.getItem('anime-tools-seasonal-scores-primary-filters') ??
        '{}',
    ) as Record<string, unknown>;
    expect(persisted.years).toEqual([2026, 2025, 2021]);
    expect(persisted.seasonYearMin).toBe(
      encodeSeasonYear('SPRING', 2021),
    );
  });
});
