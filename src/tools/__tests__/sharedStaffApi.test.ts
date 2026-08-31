import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearSessionMemoForTesting } from '../../lib/importers/anilist/toolsSessionMemo';

vi.mock('../../lib/importers/anilist/transport', () => ({
  executeAnilistQuery: vi.fn(),
}));

vi.mock('../../lib/importers/anilist/toolsImportContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/toolsImportContext')>();
  return {
    ...actual,
    getToolsImportContext: vi.fn(),
  };
});

vi.mock('../../lib/importers/anilist/toolsAnilistAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/toolsAnilistAccess')>();
  return {
    ...actual,
    ensureMediaCastFresh: vi.fn(),
    ensureMediaCastFreshBatch: vi.fn(),
    ensureMediaStudiosFreshBatch: vi.fn(),
    readShowStaffBundleFromDb: vi.fn(),
  };
});

import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  ensureMediaCastFresh,
  ensureMediaCastFreshBatch,
  ensureMediaStudiosFreshBatch,
  readShowStaffBundleFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { runSharedStaffCompare } from '../panels/sharedStaffApi';

const executeAnilistQueryMock = vi.mocked(executeAnilistQuery);
const getCtxMock = vi.mocked(getToolsImportContext);
const ensureCastMock = vi.mocked(ensureMediaCastFresh);
const ensureCastBatchMock = vi.mocked(ensureMediaCastFreshBatch);
const ensureStudiosMock = vi.mocked(ensureMediaStudiosFreshBatch);
const readStaffBundleMock = vi.mocked(readShowStaffBundleFromDb);

function searchResponse(id: number, title: string) {
  return {
    Media: {
      id,
      title: { english: title, romaji: null },
    },
  };
}

function emptyBundle(id: number, title: string) {
  return {
    id,
    title,
    coverImage: null,
    studios: {},
    productionStaff: {},
    voiceActors: {},
  };
}

beforeEach(() => {
  _clearSessionMemoForTesting();
  executeAnilistQueryMock.mockReset();
  getCtxMock.mockReset();
  ensureCastMock.mockReset();
  ensureCastBatchMock.mockReset();
  ensureStudiosMock.mockReset();
  readStaffBundleMock.mockReset();

  getCtxMock.mockReturnValue({ db: {} } as never);
  ensureCastMock.mockResolvedValue();
  ensureCastBatchMock.mockResolvedValue();
  ensureStudiosMock.mockResolvedValue();
});

describe('runSharedStaffCompare progress', () => {
  it('reports resolve, fetch-cast, and load-show phases in order', async () => {
    executeAnilistQueryMock
      .mockResolvedValueOnce(searchResponse(1, 'Show One'))
      .mockResolvedValueOnce(searchResponse(2, 'Show Two'));
    ensureCastBatchMock.mockImplementationOnce(async (_mediaIds, _options, onCheckpoint) => {
      onCheckpoint?.({ completed: 1, total: 2 });
      onCheckpoint?.({ completed: 2, total: 2 });
    });
    readStaffBundleMock
      .mockResolvedValueOnce(emptyBundle(1, 'Show One'))
      .mockResolvedValueOnce(emptyBundle(2, 'Show Two'));

    const progress = vi.fn();
    await runSharedStaffCompare({
      showSearches: ['one', 'two'],
      sortByPopularity: false,
      ignoreRelated: false,
      enableSingleShowMode: false,
      topMatchCount: 5,
      onProgress: progress,
    });

    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'resolve', showIndex: 1, showTotal: 2, label: 'one' },
      { phase: 'resolve', showIndex: 2, showTotal: 2, label: 'two' },
      { phase: 'fetch-cast', showIndex: 1, showTotal: 2 },
      { phase: 'fetch-cast', showIndex: 2, showTotal: 2 },
      { phase: 'load-show', showIndex: 1, showTotal: 2, label: 'Show One' },
      { phase: 'load-show', showIndex: 2, showTotal: 2, label: 'Show Two' },
    ]);
  });
});
