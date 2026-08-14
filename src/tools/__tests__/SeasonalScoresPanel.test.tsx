import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSeasonYear } from '../../lib/importers/anilist/filters';
import { SeasonalScoresPanel } from '../panels/SeasonalScoresPanel';
import { _clearToolsPreferencesForTesting } from '../toolsPreferences';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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
