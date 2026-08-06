import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../panels/favouritesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/favouritesApi')>();
  return {
    ...actual,
    readCachedFavouriteCharacterListLength: vi.fn(),
    runFavouritesAnalysis: vi.fn(),
  };
});

vi.mock('../useUsernameListRefresh', () => ({
  useUsernameListRefresh: (options?: {
    onAfterRefresh?: (username: string) => void | Promise<void>;
  }) => ({
    refreshing: false,
    refreshUsernameList: (username: string) => {
      void options?.onAfterRefresh?.(username);
    },
  }),
}));

import { FavouritesPanel } from '../panels/FavouritesPanel';
import {
  readCachedFavouriteCharacterListLength,
  runFavouritesAnalysis,
} from '../panels/favouritesApi';
import {
  CharacterRoleTier,
  FAVOURITES_TOP_N,
  type FavouriteCharacterRef,
  type FavouritesResult,
} from '../panels/favouritesLogic';

const runFavouritesAnalysisMock = vi.mocked(runFavouritesAnalysis);
const readCachedFavouriteCharacterListLengthMock = vi.mocked(
  readCachedFavouriteCharacterListLength,
);

const character: FavouriteCharacterRef = {
  id: 1,
  name: 'Hero',
  searchTokens: ['Hero'],
  gender: 'Female',
};

const result: FavouritesResult = {
  characterCount: 1,
  vaCount: 1,
  numSeen: 1,
  numMain: 1,
  numFemaleSeen: 1,
  byCount: [
    {
      staffId: 2,
      name: 'Voice Actor',
      imageUrl: null,
      gender: 'Male',
      displayValue: '1',
      numericValue: 1,
      characters: [character],
    },
  ],
  byAvgRank: [],
  byLogScore: [],
  byPercent: [],
  vaPercentMeta: {
    vaTotalCharacterCounts: { 2: 1 },
    vaMainRoleCharacterCounts: { 2: 1 },
    characterRoleTierById: { 1: CharacterRoleTier.Main },
    characterCount: 1,
  },
  gender: { female: [character], male: [], other: [] },
  roles: { main: [character], supporting: [], background: [], unknown: [] },
  birthdays: { '0101': [character] },
  seriesAnime: [
    {
      mediaId: 3,
      mediaType: 'ANIME',
      title: 'Show',
      titleSearchTokens: ['Show'],
      coverImage: null,
      characters: [character],
    },
  ],
  seriesManga: [],
  characterNames: ['Hero'],
  favouriteCharacters: [
    { id: 1, name: 'Hero', rank: 1, gender: 'Female' },
  ],
  favouriteStaff: [
    {
      id: 4,
      name: 'Favourite Staff',
      imageUrl: null,
      gender: 'Female',
      matchedCount: 1,
      matchedCharacters: [character],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'anime-tools-favourites-form',
    JSON.stringify({ username: 'tester' }),
  );
  readCachedFavouriteCharacterListLengthMock.mockReset();
  readCachedFavouriteCharacterListLengthMock.mockResolvedValue(5);
  runFavouritesAnalysisMock.mockReset();
  runFavouritesAnalysisMock.mockResolvedValue({
    result,
    rebuildSource: {
      characters: [],
      perCharacterEdges: [],
      consumedMediaIds: new Set(),
      favouriteStaff: [],
      vaTotalCharacterCounts: new Map(),
      vaMainRoleCharacterCounts: new Map(),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FavouritesPanel gender colours', () => {
  it('places an off-by-default character rank slider after refresh and persists by username', async () => {
    await act(async () => {
      root.render(
        <FavouritesPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    const usernameControls = container.querySelector('.tool-username-input-group');
    const refreshButton = usernameControls?.querySelector('.tool-username-refresh');
    const rankChip = usernameControls?.querySelector('.favourite-rank-chip');
    expect(refreshButton?.nextElementSibling).toBe(rankChip);
    expect(container.querySelector('.filter-bar')).toBeNull();
    expect(container.textContent).not.toContain(
      'Limits both favourite character and favourite staff lists',
    );
    expect(
      buttonWithText('rank')
        ?.closest('.filter-chip')
        ?.classList.contains('active'),
    ).toBe(false);

    await act(async () => {
      buttonWithText('rank')?.click();
    });
    expect(
      container.querySelector('.favourite-rank-slider-value output')
        ?.textContent,
    ).toBe('all (5)');
    const maxRankInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum favourite character rank"]',
    );
    expect(maxRankInput).not.toBeNull();
    expect(maxRankInput?.type).toBe('range');
    expect(maxRankInput?.max).toBe('5');
    const maxRankTextInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum favourite character rank input"]',
    );
    expect(maxRankTextInput?.classList.contains('filter-chip-slider-input')).toBe(
      true,
    );
    expect(maxRankTextInput?.value).toBe('5');
    await act(async () => {
      if (maxRankTextInput) {
        maxRankTextInput.focus();
        setInputValue(maxRankTextInput, '2');
      }
    });
    await act(async () => {
      if (maxRankTextInput) {
        maxRankTextInput.blur();
      }
    });
    expect(buttonWithText('rank · 2')).toBeDefined();
    expect(maxRankInput?.value).toBe('2');
    await act(async () => {
      if (maxRankTextInput) {
        maxRankTextInput.focus();
        setInputValue(maxRankTextInput, '5');
      }
    });
    await act(async () => {
      maxRankTextInput?.blur();
    });
    expect(buttonWithText('rank')).toBeDefined();
    expect(
      container.querySelector('.favourite-rank-slider-value output')
        ?.textContent,
    ).toBe('all (5)');
    await act(async () => {
      if (maxRankTextInput) {
        maxRankTextInput.focus();
        setInputValue(maxRankTextInput, '2');
      }
    });
    await act(async () => {
      maxRankTextInput?.blur();
    });

    const usernameInput = container.querySelector<HTMLInputElement>(
      'input[name="anilist-username"]',
    );
    await act(async () => {
      if (usernameInput) {
        setInputValue(usernameInput, 'other');
      }
    });
    expect(buttonWithText('rank')).toBeDefined();

    const otherMaxRankInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum favourite character rank"]',
    );
    await act(async () => {
      if (otherMaxRankInput) {
        setInputValue(otherMaxRankInput, '4');
      }
    });
    expect(buttonWithText('rank · 4')).toBeDefined();

    await act(async () => {
      if (usernameInput) {
        setInputValue(usernameInput, 'TESTER');
      }
    });
    expect(buttonWithText('rank · 2')).toBeDefined();
    expect(
      JSON.parse(
        localStorage.getItem('anime-tools-favourites-rank-limits') ?? '{}',
      ),
    ).toEqual({ tester: 2, other: 4 });

    await act(async () => {
      buttonWithText('Analyze')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runFavouritesAnalysisMock).toHaveBeenCalledWith(
      { username: 'TESTER', maxFavouriteRank: 2 },
      expect.any(Function),
      expect.any(AbortSignal),
      undefined,
    );
  });

  it('updates the slider range for username and cached character-list changes', async () => {
    const lengths: Record<string, number> = { tester: 5, other: 8 };
    readCachedFavouriteCharacterListLengthMock.mockImplementation(
      async (username) => lengths[username] ?? 0,
    );
    await act(async () => {
      root.render(
        <FavouritesPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      buttonWithText('rank')?.click();
    });
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Maximum favourite character rank"]',
      )?.max,
    ).toBe('5');

    const usernameInput = container.querySelector<HTMLInputElement>(
      'input[name="anilist-username"]',
    );
    await act(async () => {
      if (usernameInput) {
        setInputValue(usernameInput, 'Other');
      }
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Maximum favourite character rank"]',
      )?.max,
    ).toBe('8');

    lengths.other = 12;
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.tool-username-refresh')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonWithText('rank')?.click();
    });
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Maximum favourite character rank"]',
      )?.max,
    ).toBe('12');
  });

  it('colours staff, VAs, and every character occurrence including the birthday calendar', async () => {
    await act(async () => {
      root.render(
        <FavouritesPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    const analyze = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Analyze',
    );
    expect(analyze).toBeDefined();
    await act(async () => {
      analyze?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelectorAll('.tool-entity-btn--staff-male').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('.tool-entity-btn--staff-female').length,
    ).toBeGreaterThan(0);

    const characterLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        'a[href="https://anilist.co/character/1"]',
      ),
    );
    expect(characterLinks.length).toBeGreaterThan(4);
    expect(
      characterLinks.every((link) =>
        link.classList.contains('tool-character-name-link--female'),
      ),
    ).toBe(true);

    const calendarLabel = Array.from(container.querySelectorAll('label')).find(
      (label) => label.textContent?.trim() === 'Calendar',
    );
    await act(async () => {
      calendarLabel?.querySelector('input')?.click();
    });
    expect(
      container.querySelector(
        '.favourites-birthday-name-line .tool-character-name-link--female',
      ),
    ).not.toBeNull();
  });

  it('loads every remaining row when Load all is clicked', async () => {
    const rows = Array.from({ length: FAVOURITES_TOP_N + 3 }, (_, index) => ({
      ...result.byCount[0]!,
      staffId: 100 + index,
      name: `Voice Actor ${index + 1}`,
    }));
    runFavouritesAnalysisMock.mockResolvedValueOnce({
      result: { ...result, byCount: rows },
      rebuildSource: {
        characters: [],
        perCharacterEdges: [],
        consumedMediaIds: new Set(),
        favouriteStaff: [],
        vaTotalCharacterCounts: new Map(),
        vaMainRoleCharacterCounts: new Map(),
      },
    });

    await act(async () => {
      root.render(
        <FavouritesPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    const analyze = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Analyze',
    );
    await act(async () => {
      analyze?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstRankBlock = container.querySelector<HTMLDetailsElement>(
      '.tool-category-block[open]',
    );
    expect(firstRankBlock?.querySelectorAll('.tool-rank-list > li')).toHaveLength(
      FAVOURITES_TOP_N,
    );
    const loadAll = Array.from(
      firstRankBlock?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent === 'Load all');
    expect(loadAll).toBeDefined();
    await act(async () => {
      loadAll?.click();
    });
    expect(firstRankBlock?.querySelectorAll('.tool-rank-list > li')).toHaveLength(
      FAVOURITES_TOP_N + 3,
    );
  });
});
