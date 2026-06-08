/**
 * StaffDetailModal lazy-expansion + filmography contract.
 *
 *   - First open with `fetchedAt === null` → triggers
 *     `runAnilistStaffFilmographyExpansion(id)` once, re-reads.
 *   - First open with a `fetchedAt` → reads cache only (no expansion).
 *   - Refresh always re-runs the expansion + re-reads.
 *   - "Only items on my list" toggle filters to the cached membership
 *     set, and only renders when a cached user exists.
 *   - Clicking a credit row calls `onOpenMedia` (cross-panel nav).
 *
 * Mocks the read + runner modules to keep the test free of SQLite.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/importers/anilist/readQueries', () => ({
  productionReads: {
    getStaffFilmography: vi.fn(),
    getLatestAnilistUser: vi.fn(),
    getMediaIdsInUserList: vi.fn(),
  },
}));
vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistStaffFilmographyExpansion: vi.fn(),
}));

import { productionReads } from '../../lib/importers/anilist/readQueries';
import { runAnilistStaffFilmographyExpansion } from '../../lib/importers/anilist/runners';
import { buildAnilistMediaUrl } from '../../lib/importers/anilist/anilistSource';
import { StaffDetailModal } from '../StaffDetailModal';

const mockedGetFilmography = vi.mocked(productionReads.getStaffFilmography);
const mockedGetLatestUser = vi.mocked(productionReads.getLatestAnilistUser);
const mockedGetMyListIds = vi.mocked(productionReads.getMediaIdsInUserList);
const mockedExpand = vi.mocked(runAnilistStaffFilmographyExpansion);

function makeStaff(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name_full: `Staff ${id}`,
    name_native: null,
    image: null,
    age: null,
    gender: null,
    language_v2: 'Japanese',
    favourites: 1000,
    fetched_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

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

function makeCredit(mediaId: number, overrides: Record<string, unknown> = {}) {
  return {
    media: makeMedia(mediaId),
    productionRoles: ['Director'],
    voicedCharacters: [] as Array<{ id: number; name: string }>,
    ...overrides,
  };
}

function makeFilmography(overrides: Record<string, unknown> = {}) {
  return {
    staff: makeStaff(10),
    credits: [makeCredit(1)],
    fetchedAt: 1_700_000_000_000 as number | null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  mockedGetFilmography.mockReset();
  mockedGetLatestUser.mockReset();
  mockedGetMyListIds.mockReset();
  mockedExpand.mockReset();
  // Default: no cached user → toggle hidden, no membership lookup.
  mockedGetLatestUser.mockResolvedValue(null);
  mockedGetMyListIds.mockResolvedValue(new Set());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function flushPromises(): Promise<void> {
  // Effect chains: getStaffFilmography -> getLatestAnilistUser ->
  // (maybe expand -> getStaffFilmography) -> getMediaIdsInUserList.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderModal(
  props: Partial<{
    staffId: number;
    fallbackName: string;
    onClose: () => void;
    onOpenMedia: (mediaId: number, fallbackTitle: string) => void;
  }> = {},
): void {
  act(() => {
    root.render(
      <StaffDetailModal
        staffId={props.staffId ?? 10}
        fallbackName={props.fallbackName ?? 'Staff 10'}
        onClose={props.onClose ?? (() => {})}
        onOpenMedia={props.onOpenMedia ?? (() => {})}
      />,
    );
  });
}

describe('StaffDetailModal — lazy expansion', () => {
  it('does NOT trigger expansion when the filmography is already cached', async () => {
    mockedGetFilmography.mockResolvedValueOnce(makeFilmography());
    renderModal();
    await flushPromises();

    expect(mockedExpand).not.toHaveBeenCalled();
    expect(mockedGetFilmography).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('EN-1');
    expect(container.textContent).toContain('Director');
  });

  it('triggers expansion on first open when never fetched, then re-reads', async () => {
    mockedGetFilmography
      .mockResolvedValueOnce(makeFilmography({ credits: [], fetchedAt: null }))
      .mockResolvedValueOnce(makeFilmography());
    mockedExpand.mockResolvedValueOnce(null);

    renderModal();
    await flushPromises();

    expect(mockedExpand).toHaveBeenCalledTimes(1);
    expect(mockedExpand).toHaveBeenCalledWith(10, expect.any(Function));
    expect(mockedGetFilmography).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('EN-1');
  });

  it('refresh button re-runs expansion + re-reads even when cached', async () => {
    mockedGetFilmography
      .mockResolvedValueOnce(makeFilmography())
      .mockResolvedValueOnce(makeFilmography());
    mockedExpand.mockResolvedValueOnce(null);

    renderModal();
    await flushPromises();
    expect(mockedExpand).not.toHaveBeenCalled();

    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /Refresh/.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeDefined();
    await act(async () => {
      refreshBtn!.click();
    });
    await flushPromises();

    expect(mockedExpand).toHaveBeenCalledWith(10, expect.any(Function));
    expect(mockedGetFilmography).toHaveBeenCalledTimes(2);
  });
});

describe('StaffDetailModal — my-list toggle + navigation', () => {
  it('hides the toggle when no AniList user is cached', async () => {
    mockedGetFilmography.mockResolvedValueOnce(makeFilmography());
    mockedGetLatestUser.mockResolvedValue(null);
    renderModal();
    await flushPromises();

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('filters credits to the cached list membership when toggled on', async () => {
    mockedGetFilmography.mockResolvedValueOnce(
      makeFilmography({ credits: [makeCredit(1), makeCredit(2)] }),
    );
    mockedGetLatestUser.mockResolvedValue({ id: 5, name: 'me', fetched_at: 0 });
    // Only media 1 is on the user's list.
    mockedGetMyListIds.mockResolvedValue(new Set([1]));

    renderModal();
    await flushPromises();

    // Both credits visible before filtering.
    expect(container.textContent).toContain('EN-1');
    expect(container.textContent).toContain('EN-2');
    expect(mockedGetMyListIds).toHaveBeenCalledWith(5, [1, 2]);

    const toggle = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });

    // After toggling, only the on-list media remains.
    expect(container.textContent).toContain('EN-1');
    expect(container.textContent).not.toContain('EN-2');
  });

  it('calls onOpenMedia with the credit when a filmography row is clicked', async () => {
    mockedGetFilmography.mockResolvedValueOnce(makeFilmography());
    const onOpenMedia = vi.fn();
    renderModal({ onOpenMedia });
    await flushPromises();

    const rowBtn = container.querySelector(
      'button.anilist-detail-row-link',
    ) as HTMLButtonElement | null;
    expect(rowBtn).not.toBeNull();
    await act(async () => {
      rowBtn!.click();
    });

    expect(onOpenMedia).toHaveBeenCalledWith(1, 'EN-1');
  });

  it('opens the media AniList page on middle-click (without navigating the modal)', async () => {
    mockedGetFilmography.mockResolvedValueOnce(makeFilmography());
    const onOpenMedia = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderModal({ onOpenMedia });
    await flushPromises();

    const rowBtn = container.querySelector(
      'button.anilist-detail-row-link',
    ) as HTMLButtonElement | null;
    expect(rowBtn).not.toBeNull();
    await act(async () => {
      rowBtn!.dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      );
    });

    expect(openSpy).toHaveBeenCalledWith(
      buildAnilistMediaUrl('ANIME', 1),
      '_blank',
      'noopener,noreferrer',
    );
    expect(onOpenMedia).not.toHaveBeenCalled();
  });
});

describe('StaffDetailModal — stale refresh affordance', () => {
  function findRefreshButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      /Refresh/.test(b.textContent ?? ''),
    );
  }

  it('highlights the Refresh button when the cached filmography is stale (>90d)', async () => {
    // A 2001-era timestamp is well past the 90-day staleness threshold.
    mockedGetFilmography.mockResolvedValueOnce(
      makeFilmography({ fetchedAt: 1_000_000_000_000 }),
    );
    renderModal();
    await flushPromises();

    expect(findRefreshButton()?.className).toContain('anilist-detail-refresh-stale');
  });

  it('does not highlight the Refresh button when the cache is fresh', async () => {
    mockedGetFilmography.mockResolvedValueOnce(
      makeFilmography({ fetchedAt: Date.now() }),
    );
    renderModal();
    await flushPromises();

    expect(findRefreshButton()?.className).not.toContain(
      'anilist-detail-refresh-stale',
    );
  });
});
