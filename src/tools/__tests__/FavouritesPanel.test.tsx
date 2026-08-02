import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../panels/favouritesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/favouritesApi')>();
  return {
    ...actual,
    runFavouritesAnalysis: vi.fn(),
  };
});

import { FavouritesPanel } from '../panels/FavouritesPanel';
import { runFavouritesAnalysis } from '../panels/favouritesApi';
import {
  CharacterRoleTier,
  FAVOURITES_TOP_N,
  type FavouriteCharacterRef,
  type FavouritesResult,
} from '../panels/favouritesLogic';

const runFavouritesAnalysisMock = vi.mocked(runFavouritesAnalysis);

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
