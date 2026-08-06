import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_SORTER_SLOT_KEY,
  BUMP_WORKSPACE_STORE,
  SORTER_SLOT_STORE,
  STATE_METADATA_STORE,
  STATE_REVISION_KEY,
  STATE_SCHEMA_KEY,
  _resetStateStorageForTesting,
  _restartStateStorageForTesting,
  commitStateChanges,
  getStateStorageStatus,
  initializeStateStorage,
  readStateRecord,
  stateStorageRecordKeys,
} from '../stateStorageDb';

const SORTER_ID = 'AAAAAAAAAAAAAA';
const BUMP_ID = 'BBBBBBBBBBBBBA';
const emptyBumpWorkspace = (marker: string) => ({
  version: 1,
  view: 'staging',
  before: { items: [] },
  after: { items: [] },
  marker,
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  await _resetStateStorageForTesting();
});

describe('shared state IndexedDB', () => {
  it('transactionally migrates sorter and Bump Chart payloads before cleanup', async () => {
    const sorterManifest = {
      version: 1,
      activeId: SORTER_ID,
      slots: [{ id: SORTER_ID, name: 'Migrated slot' }],
    };
    const sorterPayload = {
      version: 4,
      items: {},
      progress: { algorithm: 'merge', comparisons: 0, done: false },
      undoRing: [],
    };
    const bumpWorkspace = {
      version: 1,
      view: 'staging',
      before: { items: [] },
      after: { items: [] },
    };
    const bumpManifest = {
      version: 1,
      slots: [
        {
          id: BUMP_ID,
          name: 'Migrated chart',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const savedBumpRecord = { version: 1, workspace: bumpWorkspace };
    localStorage.setItem('sorter:slots:v1', JSON.stringify(sorterManifest));
    localStorage.setItem(
      `sorter:slot:${SORTER_ID}:v1`,
      JSON.stringify(sorterPayload),
    );
    localStorage.setItem(
      'tools:bump-chart:workspace:v1',
      JSON.stringify(bumpWorkspace),
    );
    localStorage.setItem(
      'tools:bump-chart:saved-manifest:v1',
      JSON.stringify(bumpManifest),
    );
    localStorage.setItem(
      `tools:bump-chart:saved:v1:${BUMP_ID}`,
      JSON.stringify(savedBumpRecord),
    );

    await initializeStateStorage();

    expect(
      await readStateRecord(
        STATE_METADATA_STORE,
        stateStorageRecordKeys.sorterManifest,
      ),
    ).toEqual(sorterManifest);
    expect(await readStateRecord(SORTER_SLOT_STORE, SORTER_ID)).toEqual(
      sorterPayload,
    );
    expect(await readStateRecord(BUMP_WORKSPACE_STORE, 'active')).toEqual(
      bumpWorkspace,
    );
    expect(await readStateRecord(BUMP_WORKSPACE_STORE, BUMP_ID)).toEqual(
      savedBumpRecord,
    );
    expect(
      await readStateRecord(
        STATE_METADATA_STORE,
        stateStorageRecordKeys.bumpManifest,
      ),
    ).toEqual(bumpManifest);
    expect(localStorage.getItem(ACTIVE_SORTER_SLOT_KEY)).toBe(SORTER_ID);
    expect(localStorage.getItem(STATE_SCHEMA_KEY)).toBe('1');
    expect(localStorage.getItem('sorter:slots:v1')).toBeNull();
    expect(localStorage.getItem(`sorter:slot:${SORTER_ID}:v1`)).toBeNull();
    expect(localStorage.getItem('tools:bump-chart:workspace:v1')).toBeNull();
    expect(
      localStorage.getItem('tools:bump-chart:saved-manifest:v1'),
    ).toBeNull();
    expect(
      localStorage.getItem(`tools:bump-chart:saved:v1:${BUMP_ID}`),
    ).toBeNull();
  });

  it('resumes cleanup without overwriting a committed migration', async () => {
    const legacyWorkspace = emptyBumpWorkspace('legacy');
    localStorage.setItem(
      'tools:bump-chart:workspace:v1',
      JSON.stringify(legacyWorkspace),
    );
    const removeItem = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('interrupted cleanup');
      });

    const first = await initializeStateStorage();
    expect(first.persistent).toBe(false);
    removeItem.mockRestore();
    await _restartStateStorageForTesting();

    const committedWorkspace = emptyBumpWorkspace('committed');
    await commitStateChanges([
      {
        type: 'put',
        store: BUMP_WORKSPACE_STORE,
        key: 'active',
        value: committedWorkspace,
      },
    ]);
    localStorage.setItem(
      'tools:bump-chart:workspace:v1',
      JSON.stringify(legacyWorkspace),
    );
    localStorage.removeItem(STATE_SCHEMA_KEY);
    await _restartStateStorageForTesting();

    await initializeStateStorage();

    expect(await readStateRecord(BUMP_WORKSPACE_STORE, 'active')).toEqual(
      committedWorkspace,
    );
    expect(localStorage.getItem('tools:bump-chart:workspace:v1')).toBeNull();
    expect(localStorage.getItem(STATE_SCHEMA_KEY)).toBe('1');
  });

  it('publishes a small revision only after a durable transaction', async () => {
    await initializeStateStorage();
    await commitStateChanges(
      [
        {
          type: 'put',
          store: STATE_METADATA_STORE,
          key: 'test',
          value: { largePayload: 'stored in IndexedDB' },
        },
      ],
      { scope: 'sorter', id: SORTER_ID },
    );

    expect(await readStateRecord(STATE_METADATA_STORE, 'test')).toEqual({
      largePayload: 'stored in IndexedDB',
    });
    expect(JSON.parse(localStorage.getItem(STATE_REVISION_KEY) ?? '')).toMatchObject(
      { scope: 'sorter', id: SORTER_ID },
    );
  });

  it('keeps legacy payloads and switches to memory-only mode when IndexedDB is unavailable', async () => {
    await _resetStateStorageForTesting();
    const legacyWorkspace = emptyBumpWorkspace('keep-me');
    localStorage.setItem(
      'tools:bump-chart:workspace:v1',
      JSON.stringify(legacyWorkspace),
    );
    vi.stubGlobal('indexedDB', undefined);

    const status = await initializeStateStorage();

    expect(status.persistent).toBe(false);
    expect(getStateStorageStatus().error).toContain('unavailable');
    expect(localStorage.getItem('tools:bump-chart:workspace:v1')).not.toBeNull();
    expect(await readStateRecord(BUMP_WORKSPACE_STORE, 'active')).toEqual(
      legacyWorkspace,
    );
  });

  it('leaves malformed legacy payloads untouched', async () => {
    localStorage.setItem(
      'tools:bump-chart:workspace:v1',
      JSON.stringify({ version: 1, marker: 'malformed' }),
    );

    await initializeStateStorage();

    expect(await readStateRecord(BUMP_WORKSPACE_STORE, 'active')).toBeUndefined();
    expect(localStorage.getItem('tools:bump-chart:workspace:v1')).not.toBeNull();
  });

  it('retries blocked database upgrades before using memory-only mode', async () => {
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() =>
        request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent),
      );
      return request;
    });

    const status = await initializeStateStorage();

    expect(open).toHaveBeenCalledTimes(3);
    expect(status.persistent).toBe(false);
    expect(status.error).toContain('blocked');
  });
});
