/**
 * Phase D: AnilistDetailModal lazy-expansion contract.
 *
 *   - First open with an empty `characters` array → triggers
 *     `runAnilistMediaLazyExpansion(id)` exactly once, re-reads detail.
 *   - First open with non-empty `characters` → does NOT trigger
 *     expansion (cached path).
 *   - The explicit Refresh button always triggers expansion + bumps
 *     loadTick so the cached read fires again.
 *
 * Mocks the read + runner modules to keep the test free of SQLite.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/importers/anilist/readQueries', () => ({
  productionReads: { getMediaDetail: vi.fn() },
}));
vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistMediaLazyExpansion: vi.fn(),
}));

import { productionReads } from '../../lib/importers/anilist/readQueries';
import { runAnilistMediaLazyExpansion } from '../../lib/importers/anilist/runners';
import { AnilistDetailModal } from '../AnilistDetailModal';

const mockedGetMediaDetail = vi.mocked(productionReads.getMediaDetail);
const mockedExpand = vi.mocked(runAnilistMediaLazyExpansion);

function makeMedia(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'ANIME' as const,
    title_english: `EN-${id}`,
    title_romaji: null,
    title_native: null,
    cover_image: null,
    format: 'TV' as const,
    status: 'FINISHED' as const,
    episodes: 12,
    chapters: null,
    start_year: 2020,
    start_month: null,
    start_day: null,
    end_year: null,
    end_month: null,
    end_day: null,
    season: null,
    season_year: null,
    mean_score: null,
    favourites: null,
    country_of_origin: null,
    genres_json: null,
    synonyms_json: null,
    fetched_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function makeDetail(id: number, hasCharacters: boolean) {
  return {
    media: makeMedia(id),
    studios: [],
    tags: [],
    characters: hasCharacters
      ? [
          {
            character: {
              id: 1,
              name_full: 'Char',
              name_native: null,
              name_alternatives_json: null,
              name_alternatives_spoiler_json: null,
              image: null,
              age: null,
              gender: null,
              favourites: null,
              fetched_at: 0,
              updated_at: 0,
            },
            role: 'MAIN',
            sortOrder: 0,
            voiceActors: [],
          },
        ]
      : [],
    staff: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 18 act() requires this opt-in flag in non-RTL test envs.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  mockedGetMediaDetail.mockReset();
  mockedExpand.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flushPromises(): Promise<void> {
  // Detail modal chains: getMediaDetail -> (maybe) expand -> getMediaDetail.
  // Three Promise queue drains cover all three awaits comfortably.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AnilistDetailModal — lazy expansion', () => {
  it('triggers runAnilistMediaLazyExpansion on first open when no characters are cached', async () => {
    mockedGetMediaDetail
      .mockResolvedValueOnce(makeDetail(42, false)) // initial: empty cast
      .mockResolvedValueOnce(makeDetail(42, true)); // post-expansion read
    mockedExpand.mockResolvedValueOnce(null);

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={42}
          fallbackTitle="EN-42"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(mockedExpand).toHaveBeenCalledTimes(1);
    expect(mockedExpand).toHaveBeenCalledWith(42);
    // Two reads: initial fetch + post-expansion refetch.
    expect(mockedGetMediaDetail).toHaveBeenCalledTimes(2);
  });

  it('does NOT trigger expansion when characters are already cached', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce(makeDetail(7, true));

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={7}
          fallbackTitle="EN-7"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(mockedExpand).not.toHaveBeenCalled();
    expect(mockedGetMediaDetail).toHaveBeenCalledTimes(1);
  });

  it('refresh button triggers expansion + re-read even when characters are already cached', async () => {
    // First open: cached. Refresh: expand + re-read.
    mockedGetMediaDetail
      .mockResolvedValueOnce(makeDetail(9, true)) // initial
      .mockResolvedValueOnce(makeDetail(9, true)); // post-refresh
    mockedExpand.mockResolvedValueOnce(null);

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={9}
          fallbackTitle="EN-9"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();
    expect(mockedExpand).not.toHaveBeenCalled();

    // Find and click the refresh button by its visible label.
    const buttons = Array.from(container.querySelectorAll('button'));
    const refreshBtn = buttons.find((b) => /Refresh/.test(b.textContent ?? ''));
    expect(refreshBtn).toBeDefined();
    await act(async () => {
      refreshBtn!.click();
    });
    await flushPromises();

    expect(mockedExpand).toHaveBeenCalledWith(9);
    // Initial read + post-refresh read.
    expect(mockedGetMediaDetail).toHaveBeenCalledTimes(2);
  });

  it('shows the "couldn\u2019t find this entry" message when getMediaDetail returns null', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce(null);
    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={123}
          fallbackTitle="Unknown Title"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();
    expect(container.textContent).toMatch(/Couldn['\u2019]t find this entry/);
    expect(mockedExpand).not.toHaveBeenCalled();
  });

  it('surfaces a load error inline when getMediaDetail throws', async () => {
    mockedGetMediaDetail.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={1}
          fallbackTitle="X"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();
    expect(container.textContent).toMatch(/boom/);
  });
});
