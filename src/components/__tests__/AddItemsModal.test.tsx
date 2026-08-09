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
import type { AnilistProgressEvent } from '../../lib/importers/anilist/progress';
import type { CachedAnilistSourceSummary } from '../../lib/importers/anilist/anilistItemMaterialization';

const CACHED_SOURCES: CachedAnilistSourceSummary[] = [
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
  {
    source: {
      kind: 'favourites',
      userId: 1,
      userName: 'CachedUser',
      type: 'CHARACTERS',
    },
    count: 37,
    refreshedAt: null,
  },
];

vi.mock(
  '../../lib/importers/anilist/anilistItemMaterialization',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../lib/importers/anilist/anilistItemMaterialization')
      >();
    return {
      ...actual,
      listCachedAnilistSources: vi.fn(),
      materializeCachedAnilistSource: vi.fn(),
    };
  },
);

vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistImport: vi.fn(),
  runAnilistFavourites: vi.fn(),
}));

import {
  runAnilistFavourites,
  runAnilistImport,
} from '../../lib/importers/anilist/runners';
import {
  listCachedAnilistSources,
  materializeCachedAnilistSource,
} from '../../lib/importers/anilist/anilistItemMaterialization';
import {
  ADD_ITEMS_LAST_TAB_LS_KEY,
  AddItemsModal,
  AnilistHydrationControls,
} from '../AddItemsModal';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  vi.mocked(listCachedAnilistSources).mockResolvedValue(CACHED_SOURCES);
  vi.mocked(materializeCachedAnilistSource).mockResolvedValue([
    {
      id: 'anilist:1',
      label: 'Matched item',
      url: 'https://anilist.co/anime/1',
    },
  ]);
  vi.mocked(runAnilistImport).mockResolvedValue({
    type: 'ANIME',
    anilistUserId: 1,
    username: 'CachedUser',
    chunksFetched: 1,
    entriesWritten: 1,
  });
  vi.mocked(runAnilistFavourites).mockResolvedValue({
    type: 'CHARACTERS',
    anilistUserId: 1,
    username: 'CachedUser',
    pagesFetched: 1,
    favouritesWritten: 37,
  });
  localStorage.setItem(ANILIST_LAST_USERNAME_LS_KEY, 'CachedUser');
  localStorage.removeItem(ADD_ITEMS_LAST_TAB_LS_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(ANILIST_LAST_USERNAME_LS_KEY);
  localStorage.removeItem(ADD_ITEMS_LAST_TAB_LS_KEY);
  vi.restoreAllMocks();
});

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function renderAddItemsModal(key: string, initialTab?: 'multiple'): void {
  root.render(
    <AddItemsModal
      key={key}
      engine="merge"
      existingIds={new Set()}
      hiddenRestoreIds={new Set()}
      dbSyncRevision={0}
      initialTab={initialTab}
      onCancel={vi.fn()}
      onAddOne={vi.fn()}
      onAddMany={vi.fn()}
    />,
  );
}

describe('Add items tabs', () => {
  it('restores and updates the last-used tab', async () => {
    localStorage.setItem(ADD_ITEMS_LAST_TAB_LS_KEY, 'multiple');

    await act(async () => {
      renderAddItemsModal('first');
    });
    expect(buttonByText('Multiple').getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      buttonByText('Single').click();
    });
    expect(localStorage.getItem(ADD_ITEMS_LAST_TAB_LS_KEY)).toBe('single');

    await act(async () => {
      renderAddItemsModal('second');
    });
    expect(buttonByText('Single').getAttribute('aria-selected')).toBe('true');
  });

  it('lets an explicit initial tab replace the remembered default', async () => {
    localStorage.setItem(ADD_ITEMS_LAST_TAB_LS_KEY, 'single');

    await act(async () => {
      renderAddItemsModal('explicit', 'multiple');
    });

    expect(buttonByText('Multiple').getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem(ADD_ITEMS_LAST_TAB_LS_KEY)).toBe('multiple');
  });
});

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
    expect(runAnilistImport).toHaveBeenCalledWith(
      'CachedUser',
      'ANIME',
      expect.any(Function),
    );

    await act(async () => {
      buttonByText('Match exact names').click();
      await Promise.resolve();
    });
    const hydrationResult = container.querySelector(
      '.anilist-hydration-result',
    );
    expect(hydrationResult?.textContent).toBe('Matched 1 of 1.');
    expect(hydrationResult?.textContent).not.toContain('Unresolved rows');

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

  it('shows inline unresolved-row help only for partial matches', async () => {
    await act(async () => {
      root.render(
        <AnilistHydrationControls
          items={[
            { id: 'AAAAAAAAAAAAAQ', label: 'Matched item' },
            { id: 'BBBBBBBBBBBBBQ', label: 'Missing item' },
          ]}
          dbSyncRevision={0}
          onHydrated={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      buttonByText('Hydrate from cached AniList list…').click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText('Match exact names').click();
      await Promise.resolve();
    });

    const hydrationResult = container.querySelector(
      '.anilist-hydration-result',
    );
    expect(hydrationResult?.textContent).toContain(
      'Matched 1 of 2. Unresolved rows remain manual and can be edited in staging.',
    );
  });

  it('keeps the controls visible and shows refresh progress in the third column', async () => {
    let reportProgress:
      | ((event: AnilistProgressEvent) => void)
      | undefined;
    let finishRefresh: (() => void) | undefined;

    vi.mocked(runAnilistFavourites).mockImplementation(
      (_username, _type, onProgress) => {
        reportProgress = onProgress;
        return new Promise((resolve) => {
          finishRefresh = () =>
            resolve({
              type: 'CHARACTERS',
              anilistUserId: 1,
              username: 'CachedUser',
              pagesFetched: 2,
              favouritesWritten: 37,
            });
        });
      },
    );

    await act(async () => {
      root.render(
        <AnilistHydrationControls
          items={[{ id: 'AAAAAAAAAAAAAQ', label: 'Matched item' }]}
          dbSyncRevision={0}
          onHydrated={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText('Hydrate from cached AniList list…').click();
      await Promise.resolve();
    });

    const fields = container.querySelector<HTMLElement>(
      '.anilist-hydration-fields',
    );
    const usernameInput = fields?.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    const sourceSelect = fields?.querySelector<HTMLSelectElement>('select');
    if (!fields || !usernameInput || !sourceSelect) {
      throw new Error('Missing hydration fields');
    }

    await act(async () => {
      sourceSelect.value = 'favourites:1:CHARACTERS';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.anilist-hydration-refresh')
        ?.click();
      await Promise.resolve();
    });

    await act(async () => {
      reportProgress?.({
        kind: 'fetching-page',
        what: 'favourites',
        page: 2,
        itemsSoFar: 37,
      });
    });

    expect(fields.children[2]?.classList).toContain(
      'anilist-hydration-progress',
    );
    expect(fields.children[2]?.textContent).toContain(
      'Fetching favourites (page 2 · 37 items so far)…',
    );
    expect(usernameInput.disabled).toBe(true);
    expect(sourceSelect.disabled).toBe(true);
    expect(buttonByText('Match exact names').disabled).toBe(true);
    expect(container.textContent).not.toContain('Reading AniList cache…');

    await act(async () => {
      reportProgress?.({
        kind: 'fetching-page',
        what: 'favourites',
        page: 3,
        itemsSoFar: 50,
      });
    });
    expect(fields.children[2]?.textContent).toContain(
      'Fetching favourites (page 3 · 50 items so far)…',
    );

    vi.mocked(listCachedAnilistSources).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('.anilist-hydration-fields'),
    ).toBe(fields);
    expect(container.textContent).not.toContain('Reading AniList cache…');
    expect(usernameInput.disabled).toBe(false);
    expect(sourceSelect.disabled).toBe(false);
  });
});
