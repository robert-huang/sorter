import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearDbSyncManifestForTesting,
  getSourceSyncMeta,
  patchSourceSyncMeta,
} from '../../../db/syncManifest';

// Mock the worker-mediated DB client so `makeAnilistImportContext` doesn't
// try to spin up a Web Worker in jsdom — we don't exercise its semantics
// here, the only thing under test is the runner's post-success bookkeeping.
vi.mock('../../../db/client', () => ({
  exec: vi.fn(async () => []),
  execBatch: vi.fn(async () => undefined),
}));

const importAnilistList = vi.fn();
const importAnilistFavourites = vi.fn();
const expandAnilistMediaDetail = vi.fn();

vi.mock('../importer', () => ({
  importAnilistList: (...args: unknown[]) => importAnilistList(...args),
}));
vi.mock('../favourites', () => ({
  importAnilistFavourites: (...args: unknown[]) => importAnilistFavourites(...args),
}));
vi.mock('../lazyExpansion', () => ({
  expandAnilistMediaDetail: (...args: unknown[]) => expandAnilistMediaDetail(...args),
}));

const resolveAccessTokenForUsername = vi.fn();
const findAnilistAccountByName = vi.fn();

vi.mock('../anilistAuth', () => ({
  resolveAccessTokenForUsername: (...args: unknown[]) =>
    resolveAccessTokenForUsername(...args),
  findAnilistAccountByName: (...args: unknown[]) => findAnilistAccountByName(...args),
  AnilistAuthRequiredError: class AnilistAuthRequiredError extends Error {
    userName: string;
    constructor(userName: string) {
      super(`auth required: ${userName}`);
      this.name = 'AnilistAuthRequiredError';
      this.userName = userName;
    }
  },
}));

import { ANILIST_SOURCE_ID } from '../anilistSource';
import { AnilistAuthRequiredError } from '../anilistAuth';
import {
  runAnilistFavourites,
  runAnilistImport,
  runAnilistMediaLazyExpansion,
} from '../runners';

beforeEach(() => {
  _clearDbSyncManifestForTesting();
  importAnilistList.mockReset();
  importAnilistFavourites.mockReset();
  expandAnilistMediaDetail.mockReset();
  resolveAccessTokenForUsername.mockReset();
  findAnilistAccountByName.mockReset();
  resolveAccessTokenForUsername.mockReturnValue(null);
  findAnilistAccountByName.mockReturnValue(null);
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
});

describe('runners hasLocalDb bookkeeping', () => {
  it('flips hasLocalDb=true after a successful list import', async () => {
    importAnilistList.mockResolvedValue({
      type: 'ANIME',
      anilistUserId: 1,
      username: 'a',
      chunksFetched: 1,
      entriesWritten: 1,
    });
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);

    await runAnilistImport('a', 'ANIME');

    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(true);
  });

  it('flips hasLocalDb=true after a successful favourites import', async () => {
    importAnilistFavourites.mockResolvedValue({
      type: 'CHARACTERS',
      anilistUserId: 1,
      username: 'a',
      pagesFetched: 1,
      favouritesWritten: 1,
    });
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);

    await runAnilistFavourites('a', 'CHARACTERS');

    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(true);
  });

  it('flips hasLocalDb=true after a successful lazy expansion that wrote', async () => {
    expandAnilistMediaDetail.mockResolvedValue({
      mediaId: 42,
      charactersWritten: 1,
      staffWritten: 1,
    });
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);

    await runAnilistMediaLazyExpansion(42);

    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(true);
  });

  it('does NOT flip hasLocalDb when lazy expansion returns null (nothing written)', async () => {
    expandAnilistMediaDetail.mockResolvedValue(null);
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);

    await runAnilistMediaLazyExpansion(42);

    // The hook is gated on a real write happening — a null return means
    // the importer found no media row to expand, so nothing was written
    // and flipping the flag would lie about what's on disk.
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);
  });

  it('propagates rejection from the inner importer without setting hasLocalDb', async () => {
    importAnilistList.mockRejectedValue(new Error('scrape lock held'));

    await expect(runAnilistImport('a', 'ANIME')).rejects.toThrow('scrape lock held');

    // A failed import did NOT write any rows, so the boot-pull
    // assumption "hasLocalDb=false means we have nothing locally" stays
    // correct and the next tab open will pull from Drive.
    expect(getSourceSyncMeta(ANILIST_SOURCE_ID).hasLocalDb).toBe(false);
  });

  it('leaves hasLocalDb=true alone (idempotent no-op write)', async () => {
    patchSourceSyncMeta(ANILIST_SOURCE_ID, { hasLocalDb: true, remoteEtag: 'preserve' });
    importAnilistList.mockResolvedValue({
      type: 'ANIME',
      anilistUserId: 1,
      username: 'a',
      chunksFetched: 1,
      entriesWritten: 1,
    });

    await runAnilistImport('a', 'ANIME');

    const meta = getSourceSyncMeta(ANILIST_SOURCE_ID);
    expect(meta.hasLocalDb).toBe(true);
    // Confirm the runner short-circuited rather than overwriting unrelated meta.
    expect(meta.remoteEtag).toBe('preserve');
  });
});

describe('runAnilistImport auth token wiring', () => {
  it('passes resolved access token into import context for matching accounts', async () => {
    resolveAccessTokenForUsername.mockReturnValue('oauth-token');
    findAnilistAccountByName.mockReturnValue({ userId: 9, userName: 'alice' });
    importAnilistList.mockResolvedValue({
      type: 'ANIME',
      anilistUserId: 9,
      username: 'alice',
      chunksFetched: 1,
      entriesWritten: 1,
    });

    await runAnilistImport('alice', 'ANIME');

    expect(resolveAccessTokenForUsername).toHaveBeenCalledWith('alice');
    const ctx = importAnilistList.mock.calls[0][0];
    expect(ctx).toBeDefined();
  });

  it('propagates AnilistAuthRequiredError when stored account token is bad', async () => {
    resolveAccessTokenForUsername.mockImplementation(() => {
      throw new AnilistAuthRequiredError('alice');
    });
    findAnilistAccountByName.mockReturnValue({ userId: 9, userName: 'alice' });

    await expect(runAnilistImport('alice', 'ANIME')).rejects.toThrow(AnilistAuthRequiredError);
    expect(importAnilistList).not.toHaveBeenCalled();
  });

  it('uses public import when no stored account exists', async () => {
    resolveAccessTokenForUsername.mockReturnValue(null);
    importAnilistList.mockResolvedValue({
      type: 'ANIME',
      anilistUserId: 1,
      username: 'stranger',
      chunksFetched: 1,
      entriesWritten: 1,
    });

    await runAnilistImport('stranger', 'ANIME');

    expect(importAnilistList).toHaveBeenCalled();
  });
});
