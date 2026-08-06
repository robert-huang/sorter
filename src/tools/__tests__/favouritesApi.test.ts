/**
 * runFavouritesAnalysis caching contract:
 *
 *   - The per-character VA fetch (Path B / normal Analyze) MUST call
 *     `ensureCharacterMediaFreshBatch` before reading from the DB so the
 *     live fetch is written through to `character_media_expansion`
 *     and the next Analyze run is served from cache. Before this
 *     test was added, Analyze fetched live and threw the result
 *     away — every run re-paid the network cost forever.
 *   - The per-VA filmography fetch has the same shape via
 *     `ensureStaffFilmographyFreshBatch`.
 *   - Expand Roles flows `forceRefresh: true` through both helpers so
 *     a right-click run re-imports even fresh caches.
 *   - Completed list/favourites imports are read from SQLite, including valid
 *     empty results. Graph fallbacks are only used for missing character or
 *     staff expansion markers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/importers/anilist/graphQueries', () => ({
  hasCharacterMediaExpansion: vi.fn(),
  hasStaffFilmography: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/depaginate', () => ({
  depaginate: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  ensureCharacterMediaFreshBatch: vi.fn(),
  ensureStaffFilmographyFreshBatch: vi.fn(),
  ensureUserAnimeListFresh: vi.fn(),
  ensureUserMangaListFresh: vi.fn(),
  ensureUserFavouritesFresh: vi.fn(),
  readCharacterVoiceEdgesFromDb: vi.fn(),
  readConsumedMediaIdsFromDb: vi.fn(),
  readFavouriteCharactersFromDb: vi.fn(),
  readFavouriteStaffFromDb: vi.fn(),
  readVaCharacterEdgesFromDb: vi.fn(),
  countVaMainRoleCharactersOnConsumedMediaFromDb: vi.fn(),
}));

import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  hasCharacterMediaExpansion,
  hasStaffFilmography,
} from '../../lib/importers/anilist/graphQueries';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  ensureCharacterMediaFreshBatch,
  ensureStaffFilmographyFreshBatch,
  ensureUserAnimeListFresh,
  ensureUserMangaListFresh,
  ensureUserFavouritesFresh,
  readCharacterVoiceEdgesFromDb,
  readConsumedMediaIdsFromDb,
  readFavouriteCharactersFromDb,
  readFavouriteStaffFromDb,
  readVaCharacterEdgesFromDb,
  countVaMainRoleCharactersOnConsumedMediaFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { runFavouritesAnalysis } from '../panels/favouritesApi';
import type {
  CharacterMediaEdge,
  FavouriteCharacterInput,
  FavouritesForm,
  VaMediaEdge,
} from '../panels/favouritesLogic';

const depaginateMock = vi.mocked(depaginate);
const hasCharacterMediaExpansionMock = vi.mocked(hasCharacterMediaExpansion);
const hasStaffFilmographyMock = vi.mocked(hasStaffFilmography);
const getCtxMock = vi.mocked(getToolsImportContext);
const ensureCharacterMediaFreshBatchMock = vi.mocked(ensureCharacterMediaFreshBatch);
const ensureStaffFilmographyFreshBatchMock = vi.mocked(ensureStaffFilmographyFreshBatch);
const ensureUserAnimeListFreshMock = vi.mocked(ensureUserAnimeListFresh);
const ensureUserMangaListFreshMock = vi.mocked(ensureUserMangaListFresh);
const ensureUserFavouritesFreshMock = vi.mocked(ensureUserFavouritesFresh);
const readCharacterVoiceEdgesFromDbMock = vi.mocked(readCharacterVoiceEdgesFromDb);
const readConsumedMediaIdsFromDbMock = vi.mocked(readConsumedMediaIdsFromDb);
const readFavouriteCharactersFromDbMock = vi.mocked(readFavouriteCharactersFromDb);
const readFavouriteStaffFromDbMock = vi.mocked(readFavouriteStaffFromDb);
const readVaCharacterEdgesFromDbMock = vi.mocked(readVaCharacterEdgesFromDb);
const countVaMainRoleCharactersOnConsumedMediaFromDbMock = vi.mocked(
  countVaMainRoleCharactersOnConsumedMediaFromDb,
);

function makeCharacter(id: number, name = `Char ${id}`): FavouriteCharacterInput {
  return {
    id,
    name: { full: name, native: null },
    gender: null,
    favourites: 0,
    dateOfBirth: null,
  };
}

function makeCharEdge(mediaId: number, vaId: number): CharacterMediaEdge {
  return {
    node: {
      id: mediaId,
      title: { romaji: `Show ${mediaId}`, native: null, english: null },
      type: 'ANIME',
      format: 'TV',
    },
    characterRole: 'MAIN',
    voiceActors: [
      { id: vaId, name: { full: `VA ${vaId}`, native: null }, image: null },
    ],
  };
}

function makeVaEdge(mediaId: number, charId: number, characterRole = 'MAIN'): VaMediaEdge {
  return {
    node: { id: mediaId },
    characterRole,
    characters: [{ id: charId }],
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  depaginateMock.mockReset();
  hasCharacterMediaExpansionMock.mockReset();
  hasStaffFilmographyMock.mockReset();
  getCtxMock.mockReset();
  ensureCharacterMediaFreshBatchMock.mockReset();
  ensureStaffFilmographyFreshBatchMock.mockReset();
  ensureUserAnimeListFreshMock.mockReset();
  ensureUserMangaListFreshMock.mockReset();
  ensureUserFavouritesFreshMock.mockReset();
  readCharacterVoiceEdgesFromDbMock.mockReset();
  readConsumedMediaIdsFromDbMock.mockReset();
  readFavouriteCharactersFromDbMock.mockReset();
  readFavouriteStaffFromDbMock.mockReset();
  readVaCharacterEdgesFromDbMock.mockReset();
  countVaMainRoleCharactersOnConsumedMediaFromDbMock.mockReset();

  // Default wiring: DB-backed reads succeed everywhere so we can focus
  // on the ensure-call side of the contract. Individual tests override.
  getCtxMock.mockReturnValue({ db: { exec: vi.fn() } } as never);
  hasCharacterMediaExpansionMock.mockResolvedValue(false);
  hasStaffFilmographyMock.mockResolvedValue(false);
  ensureCharacterMediaFreshBatchMock.mockResolvedValue();
  ensureStaffFilmographyFreshBatchMock.mockResolvedValue();
  ensureUserAnimeListFreshMock.mockResolvedValue({
    id: 42,
    name: 'user',
    fetched_at: Date.now(),
  } as never);
  ensureUserMangaListFreshMock.mockResolvedValue({
    id: 42,
    name: 'user',
    fetched_at: Date.now(),
  } as never);
  ensureUserFavouritesFreshMock.mockResolvedValue({
    id: 42,
    name: 'user',
    fetched_at: Date.now(),
  } as never);
  readConsumedMediaIdsFromDbMock.mockResolvedValue(new Set([100]));
  readFavouriteCharactersFromDbMock.mockResolvedValue([
    makeCharacter(1),
    makeCharacter(2),
  ]);
  readFavouriteStaffFromDbMock.mockResolvedValue([]);
  // Each character has one appearance with one VA.
  readCharacterVoiceEdgesFromDbMock.mockImplementation(async (_db, charId) => [
    makeCharEdge(100, 1000 + Number(charId)),
  ]);
  // Each VA has one filmography entry.
  readVaCharacterEdgesFromDbMock.mockImplementation(async (_db, staffId) => [
    makeVaEdge(100, Number(staffId)),
  ]);
  countVaMainRoleCharactersOnConsumedMediaFromDbMock.mockResolvedValue(1);
});

const FORM: FavouritesForm = {
  username: 'user',
  maxFavouriteRank: null,
};

describe('runFavouritesAnalysis caching', () => {
  it('trims only character favourites before every analysis stage', async () => {
    const characters = [
      makeCharacter(1, 'Rank One'),
      makeCharacter(2, 'Rank Two'),
      {
        ...makeCharacter(3, 'Unplaced'),
        gender: 'Female',
        dateOfBirth: { month: 1, day: 1 },
      },
    ];
    readFavouriteCharactersFromDbMock.mockResolvedValue(characters);
    readFavouriteStaffFromDbMock.mockResolvedValue([
      { id: 2001, name: { full: 'Staff One' } },
      { id: 2002, name: { full: 'Staff Two' } },
      { id: 2003, name: { full: 'Unplaced Staff' } },
    ]);

    const payload = await runFavouritesAnalysis(
      { ...FORM, maxFavouriteRank: 2 },
      () => {},
    );

    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledWith(
      [1, 2],
      undefined,
    );
    expect(readCharacterVoiceEdgesFromDbMock).not.toHaveBeenCalledWith(
      expect.anything(),
      3,
    );
    expect(payload.rebuildSource.characters.map(({ id }) => id)).toEqual([1, 2]);
    expect(payload.rebuildSource.favouriteStaff.map(({ id }) => id)).toEqual([
      2001,
      2002,
      2003,
    ]);
    expect(payload.result.characterCount).toBe(2);
    expect(payload.result.favouriteCharacters.map(({ name, rank }) => ({
      name,
      rank,
    }))).toEqual([
      { name: 'Rank One', rank: 1 },
      { name: 'Rank Two', rank: 2 },
    ]);
    expect(payload.result.byCount.map(({ staffId }) => staffId)).not.toContain(
      1003,
    );
    expect(payload.result.gender.female).toEqual([]);
    expect(payload.result.birthdays['0101']).toBeUndefined();
    expect(payload.result.favouriteStaff.map(({ id }) => id)).toEqual([
      2001,
      2002,
      2003,
    ]);
  });

  it('Analyze writes through to the DB: ensureCharacterMediaFreshBatch is called once (no forceRefresh)', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledTimes(1);
    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledWith([1, 2], undefined);
    // DB reads served everything → no live fallback hit AniList.
    expect(depaginateMock).not.toHaveBeenCalled();
  });

  it('Analyze writes through per-VA filmography too: ensureStaffFilmographyFreshBatch is called once (no forceRefresh)', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    // Two characters → two unique VAs (id 1001, 1002).
    expect(ensureStaffFilmographyFreshBatchMock).toHaveBeenCalledTimes(1);
    expect(ensureStaffFilmographyFreshBatchMock).toHaveBeenCalledWith([1001, 1002], undefined);
    expect(depaginateMock).not.toHaveBeenCalled();
  });

  it('Expand Roles flows forceRefresh through to both ensure helpers', async () => {
    await runFavouritesAnalysis(FORM, () => {}, undefined, { expandRoles: true });

    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledWith([1, 2], { forceRefresh: true });
    expect(ensureStaffFilmographyFreshBatchMock).toHaveBeenCalledWith(
      [1001, 1002],
      { forceRefresh: true },
    );
  });

  it('forceRefreshFavourites only re-imports the favourites list, NOT the per-character expansion', async () => {
    await runFavouritesAnalysis(FORM, () => {}, undefined, {
      forceRefreshFavourites: true,
    });

    // forceRefreshFavourites only targets ensureUserFavouritesFresh (via
    // favouritesImportOptions) — it must NOT force-refresh the much
    // slower per-character / per-VA graph expansions (only Expand Roles
    // should do that). favouritesGraphForceOptions returns undefined
    // when only forceRefreshFavourites is set.
    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledWith([1, 2], undefined);
    expect(ensureStaffFilmographyFreshBatchMock).toHaveBeenCalledWith([1001, 1002], undefined);
    expect(ensureUserFavouritesFreshMock).toHaveBeenCalledWith(
      'user',
      expect.any(String),
      { forceRefresh: true },
    );
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledWith('user');
    expect(ensureUserMangaListFreshMock).toHaveBeenCalledWith('user');
  });

  it('imports both anime and manga lists before building consumed media ids', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledWith('user');
    expect(ensureUserMangaListFreshMock).toHaveBeenCalledWith('user');
    expect(readConsumedMediaIdsFromDbMock).toHaveBeenCalled();
  });

  it('serializes scrape-lock imports instead of running them in parallel', async () => {
    const callOrder: string[] = [];
    const mockUser = { id: 1, name: 'user', fetched_at: Date.now() };
    ensureUserAnimeListFreshMock.mockImplementation(async () => {
      callOrder.push('anime-list');
      return mockUser;
    });
    ensureUserMangaListFreshMock.mockImplementation(async () => {
      callOrder.push('manga-list');
      return mockUser;
    });
    ensureUserFavouritesFreshMock.mockImplementation(async (_username, type) => {
      callOrder.push(`favourites-${type}`);
      return mockUser;
    });

    await runFavouritesAnalysis(FORM, () => {});

    expect(callOrder).toEqual([
      'anime-list',
      'manga-list',
      'favourites-CHARACTERS',
      'favourites-STAFF',
    ]);
  });

  it('does not live-fetch a valid empty character expansion', async () => {
    readCharacterVoiceEdgesFromDbMock.mockResolvedValue([]);
    hasCharacterMediaExpansionMock.mockResolvedValue(false);

    await runFavouritesAnalysis(FORM, () => {});

    expect(depaginateMock).not.toHaveBeenCalled();
    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledTimes(1);
  });

  it('does not live-fetch valid empty character and staff expansions', async () => {
    readCharacterVoiceEdgesFromDbMock.mockResolvedValue([]);
    readVaCharacterEdgesFromDbMock.mockResolvedValue([]);
    hasCharacterMediaExpansionMock.mockResolvedValue(true);
    hasStaffFilmographyMock.mockResolvedValue(true);

    await runFavouritesAnalysis(FORM, () => {});

    expect(depaginateMock).not.toHaveBeenCalled();
    expect(ensureCharacterMediaFreshBatchMock).toHaveBeenCalledTimes(1);
    expect(ensureStaffFilmographyFreshBatchMock).toHaveBeenCalledTimes(1);
  });
});
