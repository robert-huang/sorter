/**
 * runFavouritesAnalysis caching contract:
 *
 *   - The per-character VA fetch (Path B / normal Analyze) MUST call
 *     `ensureCharacterMediaFresh` before reading from the DB so the
 *     live fetch is written through to `character_media_expansion`
 *     and the next Analyze run is served from cache. Before this
 *     test was added, Analyze fetched live and threw the result
 *     away — every run re-paid the network cost forever.
 *   - The per-VA filmography fetch has the same shape via
 *     `ensureStaffFilmographyFresh`.
 *   - Expand Roles flows `forceRefresh: true` through both helpers so
 *     a right-click run re-imports even fresh caches.
 *   - When the DB read is non-null, the defensive live fallback
 *     (`TOOLS_CHARACTER_VOICE_MEDIA_QUERY` / `TOOLS_VA_CHARACTER_MEDIA_QUERY`)
 *     is NOT hit. This is what makes the second Analyze fast.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/importers/anilist/depaginate', () => ({
  depaginate: vi.fn(),
  depaginateWithMeta: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', () => ({
  getToolsImportContext: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', () => ({
  ensureCharacterMediaFresh: vi.fn(),
  ensureStaffFilmographyFresh: vi.fn(),
  ensureUserAnimeListFresh: vi.fn(),
  ensureUserMangaListFresh: vi.fn(),
  ensureUserFavouritesFresh: vi.fn(),
  readCharacterVoiceEdgesFromDb: vi.fn(),
  readConsumedMediaIdsFromDb: vi.fn(),
  readFavouriteCharactersFromDb: vi.fn(),
  readFavouriteStaffFromDb: vi.fn(),
  readVaCharacterEdgesFromDb: vi.fn(),
}));

import { depaginate, depaginateWithMeta } from '../../lib/importers/anilist/depaginate';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  ensureCharacterMediaFresh,
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  ensureUserMangaListFresh,
  ensureUserFavouritesFresh,
  readCharacterVoiceEdgesFromDb,
  readConsumedMediaIdsFromDb,
  readFavouriteCharactersFromDb,
  readFavouriteStaffFromDb,
  readVaCharacterEdgesFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';
import { runFavouritesAnalysis } from '../panels/favouritesApi';
import type {
  CharacterMediaEdge,
  FavouriteCharacterInput,
  VaMediaEdge,
} from '../panels/favouritesLogic';

const depaginateMock = vi.mocked(depaginate);
const depaginateWithMetaMock = vi.mocked(depaginateWithMeta);
const getCtxMock = vi.mocked(getToolsImportContext);
const ensureCharacterMediaFreshMock = vi.mocked(ensureCharacterMediaFresh);
const ensureStaffFilmographyFreshMock = vi.mocked(ensureStaffFilmographyFresh);
const ensureUserAnimeListFreshMock = vi.mocked(ensureUserAnimeListFresh);
const ensureUserMangaListFreshMock = vi.mocked(ensureUserMangaListFresh);
const ensureUserFavouritesFreshMock = vi.mocked(ensureUserFavouritesFresh);
const readCharacterVoiceEdgesFromDbMock = vi.mocked(readCharacterVoiceEdgesFromDb);
const readConsumedMediaIdsFromDbMock = vi.mocked(readConsumedMediaIdsFromDb);
const readFavouriteCharactersFromDbMock = vi.mocked(readFavouriteCharactersFromDb);
const readFavouriteStaffFromDbMock = vi.mocked(readFavouriteStaffFromDb);
const readVaCharacterEdgesFromDbMock = vi.mocked(readVaCharacterEdgesFromDb);

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

function makeVaEdge(mediaId: number, charId: number): VaMediaEdge {
  return {
    node: { id: mediaId },
    characters: [{ id: charId }],
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  depaginateMock.mockReset();
  depaginateWithMetaMock.mockReset();
  getCtxMock.mockReset();
  ensureCharacterMediaFreshMock.mockReset();
  ensureStaffFilmographyFreshMock.mockReset();
  ensureUserAnimeListFreshMock.mockReset();
  ensureUserMangaListFreshMock.mockReset();
  ensureUserFavouritesFreshMock.mockReset();
  readCharacterVoiceEdgesFromDbMock.mockReset();
  readConsumedMediaIdsFromDbMock.mockReset();
  readFavouriteCharactersFromDbMock.mockReset();
  readFavouriteStaffFromDbMock.mockReset();
  readVaCharacterEdgesFromDbMock.mockReset();

  // Default wiring: DB-backed reads succeed everywhere so we can focus
  // on the ensure-call side of the contract. Individual tests override.
  getCtxMock.mockReturnValue({ db: { exec: vi.fn() } } as never);
  ensureCharacterMediaFreshMock.mockResolvedValue();
  ensureStaffFilmographyFreshMock.mockResolvedValue();
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
});

const FORM = {
  username: 'user',
  rebuildOnly: false,
} as never;

describe('runFavouritesAnalysis caching', () => {
  it('Analyze writes through to the DB: ensureCharacterMediaFresh is called per character (no forceRefresh)', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    expect(ensureCharacterMediaFreshMock).toHaveBeenCalledTimes(2);
    expect(ensureCharacterMediaFreshMock).toHaveBeenNthCalledWith(1, 1, undefined);
    expect(ensureCharacterMediaFreshMock).toHaveBeenNthCalledWith(2, 2, undefined);
    // DB reads served everything → no live fallback hit AniList.
    expect(depaginateWithMetaMock).not.toHaveBeenCalled();
  });

  it('Analyze writes through per-VA filmography too: ensureStaffFilmographyFresh is called per VA (no forceRefresh)', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    // Two characters → two unique VAs (id 1001, 1002).
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledTimes(2);
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledWith(1001, undefined);
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledWith(1002, undefined);
    expect(depaginateMock).not.toHaveBeenCalled();
  });

  it('Expand Roles flows forceRefresh through to both ensure helpers', async () => {
    await runFavouritesAnalysis(FORM, () => {}, undefined, { expandRoles: true });

    expect(ensureCharacterMediaFreshMock).toHaveBeenCalledWith(1, { forceRefresh: true });
    expect(ensureCharacterMediaFreshMock).toHaveBeenCalledWith(2, { forceRefresh: true });
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledWith(1001, { forceRefresh: true });
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledWith(1002, { forceRefresh: true });
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
    expect(ensureCharacterMediaFreshMock).toHaveBeenCalledWith(1, undefined);
    expect(ensureStaffFilmographyFreshMock).toHaveBeenCalledWith(1001, undefined);
    expect(ensureUserFavouritesFreshMock).toHaveBeenCalledWith(
      'user',
      expect.any(String),
      { forceRefresh: true },
    );
    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledWith('user', {
      forceRefresh: true,
    });
    expect(ensureUserMangaListFreshMock).toHaveBeenCalledWith('user', {
      forceRefresh: true,
    });
  });

  it('imports both anime and manga lists before building consumed media ids', async () => {
    await runFavouritesAnalysis(FORM, () => {});

    expect(ensureUserAnimeListFreshMock).toHaveBeenCalledWith('user', undefined);
    expect(ensureUserMangaListFreshMock).toHaveBeenCalledWith('user', undefined);
    expect(readConsumedMediaIdsFromDbMock).toHaveBeenCalled();
  });

  it('falls back to a capped live fetch when the DB read returns null after ensure', async () => {
    // Simulate ensureCharacterMediaFresh succeeding but the read still
    // coming back empty (e.g. character with no JP cast in the DB).
    readCharacterVoiceEdgesFromDbMock.mockResolvedValue(null);
    depaginateWithMetaMock.mockResolvedValue({
      nodes: [makeCharEdge(100, 9999)],
      truncated: false,
      pagesFetched: 1,
    });

    await runFavouritesAnalysis(FORM, () => {});

    // Live fallback ran once per character (2 characters).
    expect(depaginateWithMetaMock).toHaveBeenCalledTimes(2);
    // ensureCharacterMediaFresh still ran first per character — the
    // fallback is downstream of the write-through, not a replacement
    // for it.
    expect(ensureCharacterMediaFreshMock).toHaveBeenCalledTimes(2);
  });
});
