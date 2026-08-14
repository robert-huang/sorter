import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptationTable } from '../panels/AdaptationScoresPanel';
import {
  FranchiseFilteredView,
  FranchiseTable,
} from '../panels/FranchiseScoresPanel';
import { SeasonalColumnsView } from '../panels/SeasonalScoresPanel';
import {
  WeeklyCalendarColumnsView,
  WeeklyCalendarThemeSongShowTitle,
} from '../panels/WeeklyCalendarPanel';
import type { AdaptationMedia } from '../panels/adaptationScoresLogic';
import {
  DEFAULT_FRANCHISE_FILTERS,
  type FranchiseEntry,
} from '../panels/franchiseScoresLogic';
import type { WeeklyCalendarEntry } from '../panels/weeklyCalendarLogic';

vi.mock('../useCurrentAnilistFavourites', () => ({
  useCurrentAnilistFavourites: () => ({
    mediaIds: new Set([1, 2, 3]),
    characterIds: new Set<number>(),
    staffIds: new Set<number>(),
    studioIds: new Set<number>(),
  }),
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function media(id: number, title: string): AdaptationMedia {
  return {
    id,
    mediaType: id === 1 ? 'MANGA' : 'ANIME',
    format: id === 1 ? 'MANGA' : 'TV',
    title,
    titleSource: {
      id,
      title_english: title,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    startDate: { year: 2020, month: 1, day: 1 },
    listStatus: 'COMPLETED',
    score: 80,
    startedAt: null,
  };
}

function weeklyEntry(id: number, title: string): WeeklyCalendarEntry {
  return {
    id,
    title,
    coverImage: null,
    format: 'TV',
    score: 80,
    listStatus: 'CURRENT',
    progress: 1,
    totalEpisodes: 12,
    popularity: 100,
    mediaStatus: 'RELEASING',
    startDate: null,
    endDate: null,
    nextAiringAt: null,
    airedCount: 1,
    weekdayJs: 1,
    airingTimeMinutes: 60,
    inferredWeekday: false,
  };
}

describe('score and calendar favourite annotations', () => {
  it('annotates Franchise Scores media cells', () => {
    const entry: FranchiseEntry = {
      ...media(1, 'Favourite Franchise'),
      isSeed: true,
    };

    act(() => {
      root.render(
        <FranchiseTable
          entries={[entry]}
          seedId={entry.id}
          seedTitle={entry.title}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.anilist-detail-media-title--favourite')?.textContent)
      .toBe('Favourite Franchise ★');
  });

  it('renders activity checkboxes only while activities are enabled', () => {
    const entry: FranchiseEntry = {
      ...media(1, 'Activity Franchise'),
      isSeed: true,
    };
    const onToggleActivityMedia = vi.fn();

    act(() => {
      root.render(
        <FranchiseTable
          entries={[entry]}
          seedId={entry.id}
          seedTitle={entry.title}
          onOpenMedia={vi.fn()}
          activitiesEnabled
          uncheckedActivityMediaIds={new Set()}
          onToggleActivityMedia={onToggleActivityMedia}
        />,
      );
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Show activities for Activity Franchise"]',
    );
    expect(checkbox?.checked).toBe(true);
    act(() => checkbox?.click());
    expect(onToggleActivityMedia).toHaveBeenCalledWith(1);

    act(() => {
      root.render(
        <FranchiseTable
          entries={[entry]}
          seedId={entry.id}
          seedTitle={entry.title}
          onOpenMedia={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('.tool-franchise-th-activities')).toBeNull();
  });

  it('preserves activity checks through disable/re-enable and resets for a new seed', () => {
    const entries: FranchiseEntry[] = [
      { ...media(1, 'Seed One'), isSeed: true },
      { ...media(2, 'Seed Two'), isSeed: false },
    ];
    const renderView = (seedId: number) => {
      root.render(
        <FranchiseFilteredView
          entries={entries}
          seedId={seedId}
          seedTitle={`Seed ${seedId}`}
          franchiseUsername="ActivityUser"
          filters={DEFAULT_FRANCHISE_FILTERS}
          onPatchFilters={vi.fn()}
          onOpenMedia={vi.fn()}
        />,
      );
    };

    act(() => renderView(1));
    const activitiesButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show activities',
    );
    act(() => activitiesButton?.click());
    const secondCheckbox = () =>
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Show activities for Seed Two"]',
      );
    expect(secondCheckbox()?.checked).toBe(true);
    act(() => secondCheckbox()?.click());
    expect(secondCheckbox()?.checked).toBe(false);

    act(() => activitiesButton?.click());
    expect(secondCheckbox()).toBeNull();
    const disabledActivitiesButton = [
      ...container.querySelectorAll('button'),
    ].find((button) => button.textContent === 'Show activities');
    act(() => disabledActivitiesButton?.click());
    expect(secondCheckbox()?.checked).toBe(false);

    act(() => renderView(2));
    expect(secondCheckbox()?.checked).toBe(true);
  });

  it('annotates both Adaptation Scores media columns', () => {
    act(() => {
      root.render(
        <AdaptationTable
          blocks={[
            {
              sortKey: 0,
              diff: null,
              rows: [
                {
                  source: {
                    media: media(1, 'Favourite Source'),
                    rowSpan: 1,
                    skipRender: false,
                    showConsumptionDot: false,
                  },
                  adaptation: {
                    media: media(2, 'Favourite Adaptation'),
                    rowSpan: 1,
                    skipRender: false,
                    showConsumptionDot: false,
                  },
                },
              ],
            },
          ]}
          showDifference="off"
          diffSort={null}
          onDiffSortClick={vi.fn()}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(
      Array.from(
        container.querySelectorAll('.anilist-detail-media-title--favourite'),
      ).map((element) => element.textContent),
    ).toEqual(['Favourite Source ★', 'Favourite Adaptation ★']);
  });

  it('annotates Seasonal Scores media cells', () => {
    act(() => {
      root.render(
        <SeasonalColumnsView
          columns={[
            {
              label: 'Winter 2020',
              season: 'WINTER',
              year: 2020,
              ratedCount: 1,
              average: 80,
              shows: [
                {
                  id: 3,
                  title: 'Favourite Seasonal',
                  coverImage: null,
                  score: 80,
                },
              ],
            },
          ]}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.anilist-detail-media-title--favourite')?.textContent)
      .toBe('Favourite Seasonal ★');
  });

  it('shows Seasonal Scores repeat counts when enabled', () => {
    act(() => {
      root.render(
        <SeasonalColumnsView
          columns={[
            {
              label: 'Winter 2020',
              season: 'WINTER',
              year: 2020,
              ratedCount: 2,
              average: 80,
              shows: [
                {
                  id: 30,
                  title: 'Repeated Seasonal',
                  coverImage: null,
                  score: 80,
                  repeat: 1,
                },
              ],
            },
          ]}
          showRepeats
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.tool-stats-repeat')?.textContent).toBe(
      ' ×2',
    );
  });

  it('annotates Weekly Calendar cells and theme-song show titles', () => {
    const show = weeklyEntry(4, 'Favourite Weekly');

    act(() => {
      root.render(
        <>
          <WeeklyCalendarColumnsView
            result={{
              kind: 'columns',
              columns: [{ key: 'monday', label: 'Monday', weekdayJs: 1, shows: [show] }],
              seasonLabel: null,
            }}
            timeZone={undefined}
            showThemeSongs={false}
            themeSongCounts={new Map()}
            themeSongCache={new Map()}
            playlistCache={null}
            playlistMatchOptions={{}}
            favouriteMediaIds={new Set([show.id])}
            onOpenMedia={vi.fn()}
          />
          <WeeklyCalendarThemeSongShowTitle
            show={show}
            songCount={2}
            favourite
            onOpenMedia={vi.fn()}
          />
        </>,
      );
    });

    expect(
      Array.from(
        container.querySelectorAll('.anilist-detail-media-title--favourite'),
      ).map((element) => element.textContent),
    ).toEqual(['Favourite Weekly ★', 'Favourite Weekly ★(2)']);
  });
});
