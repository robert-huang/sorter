import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../panels/statsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/statsApi')>();
  return {
    ...actual,
    expandStatsCast: vi.fn(),
    fetchStatsData: vi.fn(),
    refreshStatsCastFromDb: vi.fn(),
  };
});

import { StatsPanel, StatsSubrowNameCell } from '../panels/StatsPanel';
import type { StatsCachedData, StatsEntry } from '../panels/statsLogic';
import { ToolStaffButton } from '../toolEntityLinks';
import {
  expandStatsCast,
  fetchStatsData,
  refreshStatsCastFromDb,
} from '../panels/statsApi';

const entry = {
  mediaId: 1,
  title: 'Cowboy Bebop',
  titleSource: {
    id: 1,
    title_romaji: 'Cowboy Bebop',
    title_english: 'Cowboy Bebop',
    title_native: 'カウボーイビバップ',
  },
  coverImage: null,
  mediaType: 'ANIME',
  format: null,
  mediaStatus: null,
  listStatus: 'COMPLETED',
  score: 10,
  repeat: 0,
  notes: null,
  progress: 26,
  progressVolumes: null,
  episodes: 26,
  chapters: null,
  volumes: null,
  duration: 24,
  meanScore: 86,
  startDate: { year: 1998, month: 4, day: 3 },
  genres: [],
  tags: [],
  studios: [],
  staffCredits: [],
  vaCredits: [],
} satisfies StatsEntry;

const fetchStatsDataMock = vi.mocked(fetchStatsData);
const expandStatsCastMock = vi.mocked(expandStatsCast);
const refreshStatsCastFromDbMock = vi.mocked(refreshStatsCastFromDb);
const favourites = {
  mediaIds: new Set([1]),
  characterIds: new Set([2]),
  staffIds: new Set<number>(),
  studioIds: new Set<number>(),
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.clear();
  fetchStatsDataMock.mockReset();
  expandStatsCastMock.mockReset();
  refreshStatsCastFromDbMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('StatsSubrowNameCell', () => {
  it('keeps character links separate from the media-row link target', () => {
    act(() => {
      root.render(
        <StatsSubrowNameCell
          entry={entry}
          link={{
            characters: [
              {
                characterId: 2,
                characterName: 'Spike Spiegel',
                characterRole: 'MAIN',
              },
            ],
          }}
          favourites={favourites}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('a a')).toBeNull();
    expect(
      container.querySelector<HTMLAnchorElement>(
        '.tool-stats-subrow-show-link-target',
      )?.getAttribute('href'),
    ).toBe('https://anilist.co/anime/1');
    expect(
      container.querySelector<HTMLAnchorElement>(
        '.tool-character-name-link',
      )?.getAttribute('href'),
    ).toBe('https://anilist.co/character/2');
    expect(container.querySelector('.tool-stats-subrow-show-title')?.textContent).toContain(
      'Cowboy Bebop ★',
    );
    expect(container.querySelector('.tool-character-name-link')?.textContent).toBe(
      'Spike Spiegel ★',
    );
  });
});

describe('stats staff name gender colours', () => {
  it.each([
    ['Female', 'tool-entity-btn--staff-female'],
    ['Male', 'tool-entity-btn--staff-male'],
  ])('uses the Favourites %s colour class', (gender, expectedClass) => {
    act(() => {
      root.render(
        <ToolStaffButton
          staffId={10}
          name={`${gender} Staff`}
          gender={gender}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    expect(
      container
        .querySelector('.tool-entity-btn')
        ?.classList.contains(expectedClass),
    ).toBe(true);
  });

  it('leaves unknown-gender names on the default colour', () => {
    act(() => {
      root.render(
        <ToolStaffButton
          staffId={20}
          name="Unknown Staff"
          gender={null}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    const link = container.querySelector('.tool-entity-btn');
    expect(
      link?.classList.contains('tool-entity-btn--staff-female'),
    ).toBe(false);
    expect(link?.classList.contains('tool-entity-btn--staff-male')).toBe(false);
  });
});

describe('StatsPanel filters', () => {
  it('bulk selects and clears media formats', () => {
    act(() => {
      root.render(
        <StatsPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    const findButton = (label: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === label,
      );
    const formatButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.filter-chip-button'),
    ).find((button) => button.textContent?.trim().startsWith('format'));

    expect(formatButton?.textContent).toContain('all');
    act(() => formatButton?.click());
    expect(findButton('Select all')?.disabled).toBe(true);
    expect(findButton('Clear')?.disabled).toBe(false);

    act(() => findButton('Clear')?.click());
    expect(formatButton?.textContent?.trim()).toBe('format');
    expect(findButton('Select all')?.disabled).toBe(false);

    act(() => findButton('Select all')?.click());
    expect(formatButton?.textContent).toContain('all');
  });

  it('renders gender immediately after the active people-role filter', () => {
    act(() => {
      root.render(
        <StatsPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    const filterLabels = (): string[] =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '.tool-stats-type-filters .filter-chip-button',
        ),
        (button) => button.textContent?.trim() ?? '',
      );
    const labels = filterLabels();
    const characterRolesIndex = labels.findIndex((label) =>
      label.startsWith('character roles'),
    );

    expect(characterRolesIndex).toBeGreaterThanOrEqual(0);
    expect(labels[characterRolesIndex + 1]).toBe('gender');

    const staffButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[aria-labelledby="tool-segmented-stats-chart"] button',
      ),
    ).find((button) => button.textContent === 'Staff');
    expect(staffButton).toBeDefined();
    act(() => {
      staffButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const staffLabels = filterLabels();
    const productionRolesIndex = staffLabels.findIndex((label) =>
      label.startsWith('production roles'),
    );
    expect(productionRolesIndex).toBeGreaterThanOrEqual(0);
    expect(staffLabels[productionRolesIndex + 1]).toBe('gender');
  });

  it('re-reads expanded cast when the local database revision changes', async () => {
    localStorage.setItem(
      'anime-tools-stats-form',
      JSON.stringify({
        username: 'tester',
        mediaType: 'ANIME',
        aggregationType: 'STAFF',
      }),
    );
    const cached: StatsCachedData = {
      username: 'tester',
      mediaType: 'ANIME',
      entries: [entry],
      castExpanded: true,
    };
    fetchStatsDataMock.mockResolvedValue(cached);
    refreshStatsCastFromDbMock.mockResolvedValue({
      ...cached,
      entries: [
        {
          ...entry,
          staffCredits: [
            {
              staffId: 10,
              staffName: 'Refreshed Staff',
              staffImage: null,
              staffGender: 'Female',
              role: 'Director',
            },
          ],
        },
      ],
    });

    await act(async () => {
      root.render(
        <StatsPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    const runButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run',
    );
    expect(runButton).toBeDefined();
    await act(async () => {
      runButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchStatsDataMock).toHaveBeenCalledTimes(1);
    expect(expandStatsCastMock).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <StatsPanel
          dbSyncRevision={1}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshStatsCastFromDbMock).toHaveBeenCalledWith(
      cached,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(expandStatsCastMock).not.toHaveBeenCalled();
  });
});
