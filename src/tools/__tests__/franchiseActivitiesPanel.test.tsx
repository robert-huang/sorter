import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRANCHISE_ACTIVITY_VIEW_LS_KEY,
  FRANCHISE_ACTIVITY_DEBOUNCE_MS,
  FranchiseActivitiesSection,
  FranchiseActivityRow,
  FranchiseFilteredView,
} from '../panels/FranchiseScoresPanel';
import type { FranchiseActivity } from '../panels/franchiseActivitiesLogic';
import {
  DEFAULT_FRANCHISE_FILTERS,
  type FranchiseEntry,
} from '../panels/franchiseScoresLogic';

const { fetchFranchiseActivitiesMock } = vi.hoisted(() => ({
  fetchFranchiseActivitiesMock: vi.fn(),
}));

vi.mock('../panels/franchiseActivitiesApi', () => ({
  fetchFranchiseActivities: fetchFranchiseActivitiesMock,
}));

vi.mock('../useCurrentAnilistFavourites', () => ({
  useCurrentAnilistFavourites: () => ({
    mediaIds: new Set<number>(),
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
});

beforeEach(() => {
  localStorage.removeItem(FRANCHISE_ACTIVITY_VIEW_LS_KEY);
  fetchFranchiseActivitiesMock.mockReset();
  fetchFranchiseActivitiesMock.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function entry(): FranchiseEntry {
  return {
    id: 100,
    mediaType: 'ANIME',
    format: 'TV',
    title: 'Activity show',
    titleSource: {
      id: 100,
      title_english: 'Activity show',
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    startDate: { year: 2020, month: 1, day: 1 },
    listStatus: 'COMPLETED',
    score: 80,
    isSeed: true,
  };
}

describe('Franchise activity panel', () => {
  it('waits for the completed username before searching activities', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <FranchiseFilteredView
          entries={[entry()]}
          seedId={100}
          seedTitle="Activity show"
          franchiseUsername="ActivityUser"
          filters={DEFAULT_FRANCHISE_FILTERS}
          onPatchFilters={vi.fn()}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    const activitiesButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Show activities');
    act(() => activitiesButton?.click());

    const usernameInput = container.querySelector<HTMLInputElement>(
      'input[name="franchise-activity-username"]',
    );
    if (!usernameInput) throw new Error('Missing activity username input');
    expect(usernameInput.getAttribute('aria-label')).toBe(
      'AniList username for activities',
    );
    expect(
      usernameInput
        .closest('.tool-franchise-activity-controls')
        ?.querySelector('button'),
    ).toBe(activitiesButton);
    expect(container.textContent).not.toContain('Activity username');
    expect(container.textContent).not.toContain(
      'Cached in this browser for 15 minutes.',
    );

    for (const username of ['r', 'ro', 'rob', 'robe', 'rober', 'robert']) {
      act(() => setInputValue(usernameInput, username));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(fetchFranchiseActivitiesMock).not.toHaveBeenCalled();
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRANCHISE_ACTIVITY_DEBOUNCE_MS - 251);
    });
    expect(fetchFranchiseActivitiesMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchFranchiseActivitiesMock).toHaveBeenCalledTimes(1);
    expect(fetchFranchiseActivitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'robert' }),
    );
  });

  it('shows replies as a blue bubble after the activity text', () => {
    const activity: FranchiseActivity = {
      id: 1,
      status: 'watched episode',
      progress: '3',
      createdAt: 1_700_000_000,
      siteUrl: 'https://anilist.co/activity/1',
      replyCount: 2,
      media: {
        id: 100,
        type: 'ANIME',
        title: 'Activity show',
        siteUrl: 'https://anilist.co/anime/100',
      },
    };

    act(() => {
      root.render(
        <FranchiseActivityRow
          activity={activity}
          showMedia={false}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    const row = container.querySelector('.tool-franchise-activity-row');
    const replies = container.querySelector('.tool-franchise-activity-replies');
    expect(row?.classList).not.toContain(
      'tool-franchise-activity-row--commented',
    );
    expect(replies?.getAttribute('aria-label')).toBe('2 replies');
    expect(replies?.getAttribute('title')).toBe('2 replies');
    expect(replies?.querySelector('svg')).not.toBeNull();
  });

  it('opens the media modal from a wrapping title with an inline format chip', () => {
    const activity: FranchiseActivity = {
      id: 1,
      status: 'watched episode',
      progress: '3',
      createdAt: 1_700_000_000,
      siteUrl: 'https://anilist.co/activity/1',
      replyCount: 0,
      media: {
        id: 100,
        type: 'ANIME',
        title: 'A very long activity show title',
        siteUrl: 'https://anilist.co/anime/100',
        format: 'TV',
      },
    };
    const onOpenMedia = vi.fn();

    act(() => {
      root.render(
        <FranchiseActivityRow
          activity={activity}
          showMedia
          onOpenMedia={onOpenMedia}
        />,
      );
    });

    const mediaLink = container.querySelector<HTMLAnchorElement>(
      '.tool-franchise-activity-media',
    );
    const activityLink = container.querySelector<HTMLAnchorElement>(
      '.tool-franchise-activity-main-link',
    );
    expect(mediaLink?.href).toBe('https://anilist.co/anime/100');
    expect(mediaLink?.textContent).toContain('A very long activity show title');
    expect(mediaLink?.textContent).toContain('TV');
    expect(
      mediaLink?.querySelector('.tool-franchise-format')?.textContent,
    ).toBe('TV');
    expect(activityLink?.href).toBe('https://anilist.co/activity/1');

    act(() => mediaLink?.click());
    expect(onOpenMedia).toHaveBeenCalledWith(
      100,
      'A very long activity show title',
    );
  });

  it('restores the media view, shows its cover, and persists view changes', () => {
    const activity: FranchiseActivity = {
      id: 1,
      status: 'completed',
      progress: null,
      createdAt: 1_700_000_000,
      siteUrl: 'https://anilist.co/activity/1',
      replyCount: 0,
      media: {
        id: 100,
        type: 'ANIME',
        title: 'Activity show',
        siteUrl: 'https://anilist.co/anime/100',
        format: 'TV',
        coverImage: 'https://images.example/100.jpg',
      },
    };
    localStorage.setItem(FRANCHISE_ACTIVITY_VIEW_LS_KEY, 'media');
    const onOpenMedia = vi.fn();

    act(() => {
      root.render(
        <FranchiseActivitiesSection
          activities={[activity]}
          loading={false}
          error={null}
          progress={null}
          mediaOrder={[100]}
          seedTitle="Activity show"
          onOpenMedia={onOpenMedia}
        />,
      );
    });

    const cover = container.querySelector<HTMLImageElement>(
      '.tool-franchise-activity-group-cover',
    );
    const groupTitle = container.querySelector<HTMLAnchorElement>(
      '.tool-franchise-activity-group-title',
    );
    expect(cover?.src).toBe('https://images.example/100.jpg');
    expect(groupTitle?.textContent).toContain('Activity show');
    expect(groupTitle?.textContent).toContain('TV');
    expect(
      groupTitle?.querySelector('.tool-franchise-format')?.textContent,
    ).toBe('TV');

    act(() => groupTitle?.click());
    expect(onOpenMedia).toHaveBeenCalledWith(100, 'Activity show');

    const dateButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Date');
    const mediaButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Media');
    expect(mediaButton?.getAttribute('aria-pressed')).toBe('true');

    act(() => dateButton?.click());
    expect(localStorage.getItem(FRANCHISE_ACTIVITY_VIEW_LS_KEY)).toBe('date');
  });
});
