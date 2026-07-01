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
  productionReads: {
    getMediaDetail: vi.fn(),
    getMediaCastExpansionStatus: vi.fn(),
  },
}));
vi.mock('../../lib/importers/anilist/runners', () => ({
  runAnilistMediaLazyExpansion: vi.fn(),
}));

import { productionReads } from '../../lib/importers/anilist/readQueries';
import { runAnilistMediaLazyExpansion } from '../../lib/importers/anilist/runners';
import {
  anilistUrlForCharacter,
  anilistUrlForStaffId,
} from '../../lib/importers/anilist/anilistLinks';
import { AnilistDetailModal } from '../AnilistDetailModal';

const mockedGetMediaDetail = vi.mocked(productionReads.getMediaDetail);
const mockedGetExpansionStatus = vi.mocked(productionReads.getMediaCastExpansionStatus);
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
    source_fetched_at: null,
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
              birth_year: null,
              birth_month: null,
              birth_day: null,
              fetched_at: 0,
              updated_at: 0,
            },
            role: 'MAIN',
            sortOrder: 0,
            voiceActors: [],
          },
        ]
      : [],
    productionStaff: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 18 act() requires this opt-in flag in non-RTL test envs.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

function makeExpansionStatus(mediaId: number, complete: boolean) {
  return {
    mediaId,
    language: 'JAPANESE',
    charactersFetchedAt: complete ? 1_700_000_000_000 : null,
    staffFetchedAt: complete ? 1_700_000_000_000 : null,
    charactersComplete: complete,
    staffComplete: complete,
  };
}

beforeEach(() => {
  mockedGetMediaDetail.mockReset();
  mockedGetExpansionStatus.mockReset();
  mockedGetExpansionStatus.mockImplementation(async (mediaId: number) =>
    makeExpansionStatus(mediaId, true),
  );
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
  it('triggers runAnilistMediaLazyExpansion on first open when cast is not fully cached', async () => {
    mockedGetMediaDetail
      .mockResolvedValueOnce(makeDetail(42, false))
      .mockResolvedValueOnce(makeDetail(42, true));
    mockedGetExpansionStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeExpansionStatus(42, true));
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
    // Second arg is the per-call onProgress callback wired by the
    // modal so the "Cast (refreshing…)" label can humanize stage
    // events while the expansion runs.
    expect(mockedExpand).toHaveBeenCalledWith(42, expect.any(Function), undefined);
    // Two reads: initial fetch + post-expansion refetch.
    expect(mockedGetMediaDetail).toHaveBeenCalledTimes(2);
  });

  it('does NOT trigger expansion when cast and staff are marked complete', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce(makeDetail(7, true));
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(7, true));

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

  it('refresh button triggers expansion + re-read even when cast is already cached', async () => {
    mockedGetMediaDetail
      .mockResolvedValueOnce(makeDetail(9, true))
      .mockResolvedValueOnce(makeDetail(9, true));
    mockedGetExpansionStatus
      .mockResolvedValueOnce(makeExpansionStatus(9, true))
      .mockResolvedValueOnce(makeExpansionStatus(9, true));
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

    expect(mockedExpand).toHaveBeenCalledWith(9, expect.any(Function), {
      scope: 'all',
      force: true,
    });
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

  // The chip pipeline (pickTitle in AnilistStartMode + getFavouritesAsItems)
  // and the modal header both resolve via `pickMediaTitle`, which defaults
  // to romaji-first (romaji → english → native). The modal header is what
  // the user sees right after clicking a chip, so it MUST resolve to the
  // same title — otherwise the header flickers once detail loads. These
  // two tests pin that shared waterfall.
  it('prefers the romaji title by default when all are present (matches chip waterfall)', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      ...makeDetail(50, true),
      media: makeMedia(50, {
        title_romaji: 'Sousou no Frieren',
        title_english: 'Frieren: Beyond Journey\u2019s End',
        title_native: '\u846C\u9001\u306E\u30D5\u30EA\u30FC\u30EC\u30F3',
      }),
    });

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={50}
          fallbackTitle="Sousou no Frieren"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const heading = container.querySelector('h2,h3,.anilist-detail-title');
    const text = (heading?.textContent ?? container.textContent ?? '').toString();
    expect(text).toContain('Sousou no Frieren');
    expect(text).not.toContain('Beyond Journey');
  });

  it('falls back to english when native and romaji are missing', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      ...makeDetail(51, true),
      media: makeMedia(51, {
        title_romaji: null,
        title_english: 'English Only',
        title_native: null,
      }),
    });

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={51}
          fallbackTitle="English Only"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('English Only');
  });
});

describe('AnilistDetailModal — metadata', () => {
  it('shows adaptation source in the metadata row', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      ...makeDetail(99750, true),
      media: makeMedia(99750, { source: 'OTHER', format: 'MOVIE', source_fetched_at: 1 }),
    });

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={99750}
          fallbackTitle="Kimisui"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Source: Other');
  });

  it('shows not-imported when source was never fetched', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      ...makeDetail(99, true),
      media: makeMedia(99, { source: null, source_fetched_at: null }),
    });

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={99}
          fallbackTitle="EN-99"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Source: Not imported');
  });

  it('shows unknown when source was fetched but AniList returned null', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      ...makeDetail(100, true),
      media: makeMedia(100, { source: null, source_fetched_at: 1 }),
    });

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={100}
          fallbackTitle="EN-100"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Source: Unknown');
  });
});

describe('AnilistDetailModal — empty cast/staff copy', () => {
  // Regression: an entry that genuinely has no cast still gets a
  // media_cast_expansion marker written (characters_complete = 1), so
  // the panel must NOT keep telling the user to Refresh once it's been
  // polled — that copy looped forever for cast-less entries.
  it('says "no cast listed" (not "cached yet") when a polled entry has no cast', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce(makeDetail(60, false));
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(60, true));

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={60}
          fallbackTitle="EN-60"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    // Status is complete → no background expansion, and the misleading
    // "cached yet / Refresh" copy must be gone.
    expect(mockedExpand).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'No cast listed for this entry on AniList.',
    );
    expect(container.textContent).not.toMatch(/No cast cached yet/);
    // Same disambiguation for the production credits section.
    expect(container.textContent).toContain(
      'No production credits listed for this entry on AniList.',
    );
  });

  it('still invites a Refresh when cast has not been fully polled', async () => {
    // Incomplete status → the modal kicks off a background expansion.
    // Once it settles with cast still empty AND incomplete, the copy
    // must invite a Refresh rather than claim AniList has no cast.
    mockedGetMediaDetail
      .mockResolvedValueOnce(makeDetail(61, false))
      .mockResolvedValueOnce(makeDetail(61, false));
    mockedGetExpansionStatus
      .mockResolvedValueOnce(makeExpansionStatus(61, false))
      .mockResolvedValueOnce(makeExpansionStatus(61, false));
    mockedExpand.mockResolvedValueOnce(null);

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={61}
          fallbackTitle="EN-61"
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    expect(mockedExpand).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/No cast cached yet\. Click .*Refresh/);
    expect(container.textContent).not.toContain('No cast listed for this entry');
  });
});

describe('AnilistDetailModal — clickable people (staff panel nav)', () => {
  function makeStaffRow(id: number, nameFull: string) {
    return {
      id,
      name_full: nameFull,
      name_native: null,
      image: null,
      age: null,
      gender: null,
      language_v2: 'Japanese',
      favourites: null,
      fetched_at: 0,
      updated_at: 0,
    };
  }

  function makeCharacterRow(id: number, nameFull: string) {
    return {
      id,
      name_full: nameFull,
      name_native: null,
      name_alternatives_json: null,
      name_alternatives_spoiler_json: null,
      image: null,
      age: null,
      gender: null,
      favourites: null,
      birth_year: null,
      birth_month: null,
      birth_day: null,
      fetched_at: 0,
      updated_at: 0,
    };
  }

  function findPersonLink(name: string): HTMLButtonElement | undefined {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.anilist-detail-person-link'),
    ).find((b) => (b.textContent ?? '').includes(name));
  }

  it('opens the staff panel when a production-staff name is clicked', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      media: makeMedia(70),
      studios: [],
      tags: [],
      characters: [],
      // "Director" survives the default key-role filter.
      productionStaff: [
        { staff: makeStaffRow(200, 'Hayao Miyazaki'), role: 'Director', sortOrder: 0 },
      ],
    });
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(70, true));
    const onOpenStaff = vi.fn();

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={70}
          fallbackTitle="EN-70"
          onClose={() => {}}
          onOpenStaff={onOpenStaff}
        />,
      );
    });
    await flushPromises();

    const btn = findPersonLink('Hayao Miyazaki');
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.click();
    });
    expect(onOpenStaff).toHaveBeenCalledWith(200, 'Hayao Miyazaki');
  });

  it('opens the staff panel when a cast voice-actor name is clicked', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      media: makeMedia(71),
      studios: [],
      tags: [],
      characters: [
        {
          character: makeCharacterRow(300, 'Faye Valentine'),
          role: 'MAIN',
          sortOrder: 0,
          voiceActors: [makeStaffRow(201, 'Megumi Hayashibara')],
        },
      ],
      productionStaff: [],
    });
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(71, true));
    const onOpenStaff = vi.fn();

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={71}
          fallbackTitle="EN-71"
          onClose={() => {}}
          onOpenStaff={onOpenStaff}
        />,
      );
    });
    await flushPromises();

    const btn = findPersonLink('Megumi Hayashibara');
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.click();
    });
    expect(onOpenStaff).toHaveBeenCalledWith(201, 'Megumi Hayashibara');
  });

  it('middle-click opens the AniList page for characters and voice actors', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      media: makeMedia(73),
      studios: [],
      tags: [],
      characters: [
        {
          character: makeCharacterRow(300, 'Faye Valentine'),
          role: 'MAIN',
          sortOrder: 0,
          voiceActors: [makeStaffRow(201, 'Megumi Hayashibara')],
        },
      ],
      productionStaff: [],
    });
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(73, true));
    const onOpenStaff = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await act(async () => {
      root.render(
        <AnilistDetailModal
          mediaId={73}
          fallbackTitle="EN-73"
          onClose={() => {}}
          onOpenStaff={onOpenStaff}
        />,
      );
    });
    await flushPromises();

    const charName = Array.from(
      container.querySelectorAll('.anilist-detail-character-name'),
    ).find((el) => (el.textContent ?? '').includes('Faye Valentine'));
    expect(charName).toBeDefined();
    act(() => {
      charName!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    expect(openSpy).toHaveBeenLastCalledWith(
      anilistUrlForCharacter(300),
      '_blank',
      'noopener,noreferrer',
    );

    // Middle-clicking the VA opens their AniList page, not the staff panel.
    const vaBtn = findPersonLink('Megumi Hayashibara');
    expect(vaBtn).toBeDefined();
    act(() => {
      vaBtn!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    expect(openSpy).toHaveBeenLastCalledWith(
      anilistUrlForStaffId(201),
      '_blank',
      'noopener,noreferrer',
    );
    expect(onOpenStaff).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it('renders staff names as plain text when onOpenStaff is not wired', async () => {
    mockedGetMediaDetail.mockResolvedValueOnce({
      media: makeMedia(72),
      studios: [],
      tags: [],
      characters: [],
      productionStaff: [
        { staff: makeStaffRow(202, 'Shinichiro Watanabe'), role: 'Director', sortOrder: 0 },
      ],
    });
    mockedGetExpansionStatus.mockResolvedValueOnce(makeExpansionStatus(72, true));

    await act(async () => {
      root.render(
        <AnilistDetailModal mediaId={72} fallbackTitle="EN-72" onClose={() => {}} />,
      );
    });
    await flushPromises();

    expect(container.querySelector('button.anilist-detail-person-link')).toBeNull();
    expect(container.textContent).toContain('Shinichiro Watanabe');
  });
});
