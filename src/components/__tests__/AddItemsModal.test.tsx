import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Item } from '../../lib/types';
import { ANILIST_LAST_USERNAME_LS_KEY } from '../../lib/importers/anilist/lastUsername';

vi.mock(
  '../../lib/importers/anilist/anilistItemMaterialization',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../lib/importers/anilist/anilistItemMaterialization')
      >();
    return {
      ...actual,
      listCachedAnilistSources: vi.fn().mockResolvedValue([
        {
          source: {
            kind: 'list',
            userId: 2,
            userName: 'Mannerpots',
            type: 'ANIME',
          },
          count: 1,
          refreshedAt: Date.now(),
        },
        {
          source: {
            kind: 'list',
            userId: 1,
            userName: 'CachedUser',
            type: 'ANIME',
          },
          count: 1,
          refreshedAt: null,
        },
      ]),
      materializeCachedAnilistSource: vi.fn().mockResolvedValue([
        {
          id: 'anilist:1',
          label: 'Matched item',
          url: 'https://anilist.co/anime/1',
        },
      ]),
    };
  },
);

vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistImport: vi.fn().mockResolvedValue({ username: 'CachedUser' }),
  runAnilistFavourites: vi.fn().mockResolvedValue({ username: 'CachedUser' }),
}));

import { runAnilistImport } from '../../lib/importers/anilist/runners';
import { AnilistHydrationControls } from '../AddItemsModal';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.setItem(ANILIST_LAST_USERNAME_LS_KEY, 'CachedUser');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(ANILIST_LAST_USERNAME_LS_KEY);
  vi.restoreAllMocks();
});

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

describe('AniList hydration controls', () => {
  it('uses the remembered username and clears prior matches when rows clear', async () => {
    const inputItem: Item = {
      id: 'AAAAAAAAAAAAAQ',
      label: 'Matched item',
    };

    await act(async () => {
      root.render(
        <AnilistHydrationControls
          items={[inputItem]}
          dbSyncRevision={0}
          onHydrated={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(
      buttonByText('Hydrate from cached AniList list…').title,
    ).toContain('Match item names exactly');

    await act(async () => {
      buttonByText('Hydrate from cached AniList list…').click();
      await Promise.resolve();
    });

    const usernameInput =
      container.querySelector<HTMLInputElement>('input[type="text"]');
    if (!usernameInput) throw new Error('Missing cached username input');
    expect(usernameInput.value).toBe('CachedUser');
    const refreshButton = container.querySelector<HTMLButtonElement>(
      '.anilist-hydration-refresh',
    );
    expect(refreshButton?.title).toContain('Last refreshed: never');
    expect(refreshButton?.classList.contains('is-stale')).toBe(true);
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
    });
    expect(runAnilistImport).toHaveBeenCalledWith('CachedUser', 'ANIME');

    await act(async () => {
      buttonByText('Match exact names').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Matched 1 of 1');

    await act(async () => {
      root.render(
        <AnilistHydrationControls
          items={[]}
          dbSyncRevision={0}
          onHydrated={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Matched 1 of 1');
    expect(container.textContent).not.toContain('Cached username');
  });
});
