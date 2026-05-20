import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutosaveBlob } from '../storage';
import {
  AUTOSAVE_DEBOUNCE_MS,
  _clearPostWriteListeners,
  _resetAvailabilityCache,
  clearCloudBinding,
  createSlot,
  flushAutosave,
  primeActiveSlot,
  readManifest,
  scheduleAutosave,
  setCloudOptIn,
  setCloudPulled,
  setCloudPushed,
  subscribeAfterWrite,
} from '../storage';
import type {
  AuthState,
  CloudProvider,
  CloudPullResult,
  CloudPushOptions,
  CloudPushResult,
  CloudSlotMeta,
} from '../cloud';
import {
  _resetCloudProviderForTesting,
  _setCloudProviderForTesting,
  buildSlotFilename,
  getAuthState,
  listCloudSlots,
  parseDisplayNameFromFilename,
  pullSlot,
  pushSlot,
  registerDefaultCloudProvider,
  removeCloudSlot,
  signIn,
  signOut,
} from '../cloud';
import { GoogleDriveProvider } from '../cloud/googleDrive';
import type { MergeProgress } from '../types';

// ---------- shared helpers ----------

function makeProgress(comparisons = 0, done = false): MergeProgress {
  return {
    engine: 'merge',
    queue: [['a']],
    current: null,
    comparisons,
    done,
    hidden: [],
    totalComparisonsEverNeeded: 0,
    unplaced: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
}

function makeBlob(comparisons = 0, done = false): AutosaveBlob {
  return {
    items: { a: { id: 'a', label: 'Alpha' }, b: { id: 'b', label: 'Bravo' } },
    progress: makeProgress(comparisons, done),
    undoRing: [],
  };
}

class StubProvider implements CloudProvider {
  state: AuthState = { status: 'signed-out' };
  calls: string[] = [];
  listResult: CloudSlotMeta[] = [];
  pullResult: CloudPullResult | null = null;
  pushResult: CloudPushResult | null = null;
  async signIn(): Promise<void> {
    this.calls.push('signIn');
  }
  async handleAuthRedirect(): Promise<AuthState> {
    this.calls.push('handleAuthRedirect');
    return this.state;
  }
  async signOut(): Promise<void> {
    this.calls.push('signOut');
    this.state = { status: 'signed-out' };
  }
  getAuthState(): AuthState {
    return this.state;
  }
  async refreshTokenIfNeeded(): Promise<void> {
    this.calls.push('refreshTokenIfNeeded');
  }
  async pickFolder(): Promise<{ folderId: string; folderName: string }> {
    this.calls.push('pickFolder');
    return { folderId: 'F1', folderName: 'Sorter Backups' };
  }
  async clearFolder(): Promise<void> {
    this.calls.push('clearFolder');
  }
  subscribeAuthChange(): () => void {
    return () => {};
  }
  async listCloudSlots(): Promise<CloudSlotMeta[]> {
    this.calls.push('listCloudSlots');
    return this.listResult;
  }
  async pullSlot(cloudId: string): Promise<CloudPullResult> {
    this.calls.push(`pullSlot:${cloudId}`);
    if (!this.pullResult) throw new Error('no stub pull result');
    return this.pullResult;
  }
  async pushSlot(
    cloudId: string | null,
    _blob: AutosaveBlob,
    opts: CloudPushOptions,
  ): Promise<CloudPushResult> {
    this.calls.push(`pushSlot:${cloudId}:${opts.desiredFilename}`);
    if (!this.pushResult) throw new Error('no stub push result');
    return this.pushResult;
  }
  async removeCloudSlot(cloudId: string): Promise<void> {
    this.calls.push(`removeCloudSlot:${cloudId}`);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  _resetAvailabilityCache();
  primeActiveSlot();
  _clearPostWriteListeners();
  _resetCloudProviderForTesting();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  _resetCloudProviderForTesting();
  vi.restoreAllMocks();
});

// ---------- filename helpers ----------

describe('buildSlotFilename', () => {
  it('joins slot name + id with the .sorter.json suffix', () => {
    expect(buildSlotFilename('Movies', 'aBcd1234')).toBe('Movies_aBcd1234.sorter.json');
  });
  it('replaces runs of filesystem-hostile characters with a single underscore', () => {
    // `:/` collapses to one `_`, trailing `?` collapses to one `_` which
    // then gets trimmed since it's at the end. Run-collapsing keeps
    // filenames from sprouting underscore noise on common patterns
    // like `https://...` slot names.
    expect(buildSlotFilename('Best:/movies?', 'abc')).toBe('Best_movies_abc.sorter.json');
    // Two separate runs each collapse independently.
    expect(buildSlotFilename('Foo: bar / baz', 'abc')).toBe('Foo_ bar _ baz_abc.sorter.json');
  });
  it('falls back to "Untitled" when the name sanitizes to empty', () => {
    expect(buildSlotFilename('///', 'abc')).toBe('Untitled_abc.sorter.json');
  });
  it('caps long names so the filename stays under Drive UI legibility', () => {
    const longName = 'x'.repeat(200);
    const out = buildSlotFilename(longName, 'abc');
    // Sanitized name capped to 80 + underscore + id + extension
    expect(out.length).toBeLessThanOrEqual(80 + 1 + 3 + '.sorter.json'.length);
    expect(out.endsWith('_abc.sorter.json')).toBe(true);
  });
});

describe('parseDisplayNameFromFilename', () => {
  it('peels off the id suffix + extension', () => {
    expect(parseDisplayNameFromFilename('Movies_aBcd1234.sorter.json')).toBe('Movies');
  });
  it('handles names that themselves contain underscores', () => {
    // Everything before the LAST underscore is the display name.
    expect(parseDisplayNameFromFilename('My_2026_list_abc.sorter.json')).toBe('My_2026_list');
  });
  it('returns the input verbatim when no .sorter.json suffix', () => {
    expect(parseDisplayNameFromFilename('Movies')).toBe('Movies');
  });
});

// ---------- proxy plumbing ----------

describe('cloud proxy', () => {
  it('delegates signIn / signOut / listCloudSlots / pushSlot / removeCloudSlot to the active provider', async () => {
    const stub = new StubProvider();
    stub.listResult = [
      {
        cloudId: 'F1F1',
        displayName: 'Hello',
        filename: 'Hello_abc.sorter.json',
        sizeBytes: 1234,
        updatedAt: '2026-05-20T00:00:00.000Z',
        etag: '1',
      },
    ];
    stub.pushResult = {
      cloudId: 'F1F1',
      etag: '2',
      updatedAt: '2026-05-20T00:01:00.000Z',
    };
    _setCloudProviderForTesting(stub);
    await signIn();
    const list = await listCloudSlots();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Hello');
    await pushSlot(null, makeBlob(), {
      desiredFilename: 'Hello_abc.sorter.json',
      sorterSlotId: 'abc',
      displayName: 'Hello',
    });
    await removeCloudSlot('F1F1');
    await signOut();
    expect(stub.calls).toEqual([
      'signIn',
      'listCloudSlots',
      'pushSlot:null:Hello_abc.sorter.json',
      'removeCloudSlot:F1F1',
      'signOut',
    ]);
  });

  it('routes a pull through the stub and returns the bundled result', async () => {
    const stub = new StubProvider();
    stub.pullResult = {
      blob: makeBlob(3),
      etag: '7',
      updatedAt: '2026-05-20T00:00:00.000Z',
      sorterSlotId: 'abc',
    };
    _setCloudProviderForTesting(stub);
    const result = await pullSlot('F1F1');
    expect(result.blob.progress.comparisons).toBe(3);
    expect(result.etag).toBe('7');
    expect(stub.calls).toContain('pullSlot:F1F1');
  });

  it('getAuthState returns signed-out when no provider is registered (defensive boot path)', () => {
    expect(getAuthState()).toEqual({ status: 'signed-out' });
  });

  it('lazily instantiates the default-provider factory only on first real use', async () => {
    let factoryCalls = 0;
    registerDefaultCloudProvider(() => {
      factoryCalls += 1;
      return new StubProvider();
    });
    // getAuthState falls back to signed-out without instantiation while
    // factory is registered but no real op has happened yet — but
    // since the proxy now sees a factory, it goes through getProvider.
    // The first invocation instantiates the provider exactly once.
    getAuthState();
    getAuthState();
    expect(factoryCalls).toBe(1);
  });
});

// ---------- storage seam ----------

describe('subscribeAfterWrite', () => {
  it('fires after every successful autosave write to the active slot', async () => {
    const calls: string[] = [];
    subscribeAfterWrite((id) => calls.push(id));
    const result = createSlot(makeBlob(), 'A');
    expect(result).not.toBeNull();
    // createSlot writes the blob synchronously but does NOT go through
    // the autosave write path — the seam is for autosave specifically.
    // Trigger an autosave write by scheduling + flushing.
    scheduleAutosave(makeBlob(2));
    flushAutosave();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]).toBe(result!.meta.id);
  });

  it('isolates listener exceptions so a broken subscriber cannot break the write path', () => {
    subscribeAfterWrite(() => {
      throw new Error('subscriber boom');
    });
    const ok: string[] = [];
    subscribeAfterWrite((id) => ok.push(id));
    const result = createSlot(makeBlob(), 'A');
    expect(result).not.toBeNull();
    scheduleAutosave(makeBlob(2));
    // Should not throw.
    expect(() => flushAutosave()).not.toThrow();
    // The good subscriber still fired.
    expect(ok[ok.length - 1]).toBe(result!.meta.id);
  });

  it('supports unsubscribe', () => {
    const calls: string[] = [];
    const unsub = subscribeAfterWrite((id) => calls.push(id));
    const result = createSlot(makeBlob(), 'A');
    scheduleAutosave(makeBlob(2));
    flushAutosave();
    const beforeUnsub = calls.length;
    unsub();
    scheduleAutosave(makeBlob(3));
    flushAutosave();
    expect(calls.length).toBe(beforeUnsub);
    void result;
  });
});

describe('cloud-meta helpers', () => {
  it('setCloudOptIn flips the opt-in flag', () => {
    const r = createSlot(makeBlob(), 'A');
    expect(r).not.toBeNull();
    setCloudOptIn(r!.meta.id, true);
    const m = readManifest();
    const slot = m.slots.find((s) => s.id === r!.meta.id);
    expect(slot?.cloudOptIn).toBe(true);
    setCloudOptIn(r!.meta.id, false);
    const m2 = readManifest();
    const slot2 = m2.slots.find((s) => s.id === r!.meta.id);
    expect(slot2?.cloudOptIn).toBe(false);
  });

  it('setCloudPushed stamps id + etag + timestamps atomically', () => {
    const r = createSlot(makeBlob(), 'A');
    setCloudPushed(r!.meta.id, {
      cloudId: 'F1F1F1',
      cloudEtag: '9',
      cloudPushedAt: '2026-05-20T01:00:00.000Z',
      cloudUpdatedAt: '2026-05-20T01:00:00.000Z',
    });
    const slot = readManifest().slots.find((s) => s.id === r!.meta.id);
    expect(slot?.cloudId).toBe('F1F1F1');
    expect(slot?.cloudEtag).toBe('9');
    expect(slot?.cloudPushedAt).toBe('2026-05-20T01:00:00.000Z');
    expect(slot?.cloudUpdatedAt).toBe('2026-05-20T01:00:00.000Z');
  });

  it('setCloudPulled stamps id + etag + cloudUpdatedAt but leaves cloudPushedAt untouched', () => {
    const r = createSlot(makeBlob(), 'A');
    setCloudPushed(r!.meta.id, {
      cloudId: 'F1F1F1',
      cloudEtag: '5',
      cloudPushedAt: '2026-05-20T00:00:00.000Z',
      cloudUpdatedAt: '2026-05-20T00:00:00.000Z',
    });
    setCloudPulled(r!.meta.id, {
      cloudId: 'F1F1F1',
      cloudEtag: '7',
      cloudUpdatedAt: '2026-05-20T02:00:00.000Z',
    });
    const slot = readManifest().slots.find((s) => s.id === r!.meta.id);
    expect(slot?.cloudPushedAt).toBe('2026-05-20T00:00:00.000Z');
    expect(slot?.cloudUpdatedAt).toBe('2026-05-20T02:00:00.000Z');
    expect(slot?.cloudEtag).toBe('7');
  });

  it('clearCloudBinding wipes id/etag/timestamps but keeps cloudOptIn', () => {
    const r = createSlot(makeBlob(), 'A');
    setCloudOptIn(r!.meta.id, true);
    setCloudPushed(r!.meta.id, {
      cloudId: 'F1F1F1',
      cloudEtag: '1',
      cloudPushedAt: '2026-05-20T00:00:00.000Z',
      cloudUpdatedAt: '2026-05-20T00:00:00.000Z',
    });
    clearCloudBinding(r!.meta.id);
    const slot = readManifest().slots.find((s) => s.id === r!.meta.id);
    expect(slot?.cloudId).toBeUndefined();
    expect(slot?.cloudEtag).toBeUndefined();
    expect(slot?.cloudPushedAt).toBeUndefined();
    expect(slot?.cloudUpdatedAt).toBeUndefined();
    expect(slot?.cloudOptIn).toBe(true);
  });
});

// ---------- GoogleDriveProvider with mocked fetch ----------

describe('GoogleDriveProvider auth state + token storage', () => {
  it('reports signed-out when localStorage has no tokens', () => {
    const p = new GoogleDriveProvider();
    expect(p.getAuthState()).toEqual({ status: 'signed-out' });
  });

  it('reports signed-in when an unexpired access token is present', () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({
        accessToken: 'A',
        refreshToken: 'R',
        expiresAt: Date.now() + 5 * 60_000,
      }),
    );
    const p = new GoogleDriveProvider();
    expect(p.getAuthState().status).toBe('signed-in');
  });

  it('reports expired when the access token is past expiry and there is no refresh token', () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({
        accessToken: 'A',
        refreshToken: '',
        expiresAt: Date.now() - 1000,
      }),
    );
    const p = new GoogleDriveProvider();
    expect(p.getAuthState().status).toBe('expired');
  });

  it('signOut clears tokens AND folder + fires the auth listener', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'F1', folderName: 'Backups' }),
    );
    const p = new GoogleDriveProvider();
    const states: AuthState[] = [];
    p.subscribeAuthChange((s) => states.push(s));
    await p.signOut();
    expect(localStorage.getItem('sorter:cloud:tokens:v1')).toBeNull();
    expect(localStorage.getItem('sorter:cloud:folder:v1')).toBeNull();
    expect(states[states.length - 1]?.status).toBe('signed-out');
  });

  it('exposes folderId + folderName in getAuthState when both tokens and folder are present', () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'F1', folderName: 'Backups' }),
    );
    const p = new GoogleDriveProvider();
    const s = p.getAuthState();
    expect(s.folderId).toBe('F1');
    expect(s.folderName).toBe('Backups');
  });
});

describe('GoogleDriveProvider.refreshTokenIfNeeded', () => {
  it('no-ops when the access token is comfortably valid', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 10 * 60_000 }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const p = new GoogleDriveProvider();
    await p.refreshTokenIfNeeded();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exchanges the refresh token when the access token is near expiry', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'OLD', refreshToken: 'R', expiresAt: Date.now() + 10_000 }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'NEW', expires_in: 3600 }), { status: 200 }),
    );
    const p = new GoogleDriveProvider();
    await p.refreshTokenIfNeeded();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem('sorter:cloud:tokens:v1') ?? '{}') as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe('NEW');
    // Refresh token preserved when the response doesn't include a new one.
    expect(stored.refreshToken).toBe('R');
  });

  it('clears tokens on a refresh-token rejection so the app transitions to expired', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'OLD', refreshToken: 'R', expiresAt: Date.now() + 10_000 }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );
    const p = new GoogleDriveProvider();
    await p.refreshTokenIfNeeded();
    expect(localStorage.getItem('sorter:cloud:tokens:v1')).toBeNull();
    expect(p.getAuthState().status).toBe('signed-out');
  });

  it('clears tokens when no refresh token is available + near expiry', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'OLD', refreshToken: '', expiresAt: Date.now() + 10_000 }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const p = new GoogleDriveProvider();
    await p.refreshTokenIfNeeded();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('sorter:cloud:tokens:v1')).toBeNull();
  });
});

describe('GoogleDriveProvider.listCloudSlots', () => {
  it('returns empty when no folder has been picked', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    const p = new GoogleDriveProvider();
    const list = await p.listCloudSlots();
    expect(list).toEqual([]);
  });

  it('queries Drive scoped to the chosen folder and maps the response', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'FOLDER', folderName: 'Backups' }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'F1F1F1',
              name: 'Movies_aBcd1234.sorter.json',
              modifiedTime: '2026-05-20T00:00:00.000Z',
              size: '8192',
              version: '7',
              appProperties: { sorterSlotId: 'aBcd1234', sorterDisplayName: 'Movies' },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleDriveProvider();
    const list = await p.listCloudSlots();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain('FOLDER');
    expect(calledUrl).toContain('.sorter.json');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      cloudId: 'F1F1F1',
      displayName: 'Movies',
      filename: 'Movies_aBcd1234.sorter.json',
      sizeBytes: 8192,
      etag: '7',
      sorterSlotId: 'aBcd1234',
    });
  });

  it('prefers md5Checksum over version when Drive returns both (etag stays stable across metadata-only version bumps)', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'F', folderName: 'B' }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'F1',
              name: 'X_abc.sorter.json',
              modifiedTime: '2026-05-20T00:00:00.000Z',
              size: '100',
              version: '99',
              md5Checksum: 'abc123md5',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleDriveProvider();
    const list = await p.listCloudSlots();
    // md5 wins over version so post-upload version-bumps (a Drive
    // internal) don't masquerade as cross-device edits.
    expect(list[0].etag).toBe('abc123md5');
  });

  it('falls back to filename-derived display name when appProperties is missing', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'F', folderName: 'B' }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'X',
              name: 'Old_abc.sorter.json',
              modifiedTime: '2026-05-20T00:00:00.000Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleDriveProvider();
    const list = await p.listCloudSlots();
    expect(list[0].displayName).toBe('Old');
  });
});

describe('GoogleDriveProvider.pullSlot', () => {
  it('does two round-trips (meta + body) and assembles the result', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    const bodyBlob = makeBlob(5);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'F1F1F1',
            name: 'Movies_abc.sorter.json',
            modifiedTime: '2026-05-20T03:00:00.000Z',
            version: '11',
            appProperties: { sorterSlotId: 'abc' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(bodyBlob), { status: 200 }));
    const p = new GoogleDriveProvider();
    const result = await p.pullSlot('F1F1F1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.blob.progress.comparisons).toBe(5);
    expect(result.etag).toBe('11');
    expect(result.sorterSlotId).toBe('abc');
    expect(result.updatedAt).toBe('2026-05-20T03:00:00.000Z');
  });

  it('prefers md5Checksum over version on pull (etag remains content-derived)', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    const bodyBlob = makeBlob(3);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'F1',
            name: 'X.sorter.json',
            modifiedTime: '2026-05-20T03:00:00.000Z',
            version: '42',
            md5Checksum: 'pulled-md5',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(bodyBlob), { status: 200 }));
    const p = new GoogleDriveProvider();
    const result = await p.pullSlot('F1');
    expect(result.etag).toBe('pulled-md5');
  });

  it('throws when the body is missing required fields', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'X', name: 'X.sorter.json', modifiedTime: '2026-05-20T00:00:00.000Z', version: '1' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const p = new GoogleDriveProvider();
    await expect(p.pullSlot('X')).rejects.toThrow(/missing required fields/);
  });
});

describe('GoogleDriveProvider hash stash/restore (share-link survival)', () => {
  /**
   * Plan: phase1_hash_restore — verify that a `#share=...` payload
   * stashed before the OAuth redirect is restored to the URL after the
   * post-redirect handler runs. Personal-scale path: user opens a
   * share link, hits "Sign in to cloud" mid-import, comes back via
   * the OAuth round-trip, share modal should still pop on the
   * restored hash.
   */

  function stubLocation(path: string, hash: string = ''): void {
    // jsdom: window.history.replaceState is the safe way to mutate URL
    // without triggering navigation.
    window.history.replaceState(null, '', `${path}${hash}`);
  }

  it('restores the stashed hash on a successful auth redirect', async () => {
    // 1. Pre-stash a share-link hash (mimicking what signIn would do).
    sessionStorage.setItem('sorter:preAuthHash', '#share=eyJraW5kIjoicmFua2luZyJ9');
    // 2. Simulate the post-redirect URL: code + state in query, no hash.
    stubLocation('/', '');
    window.history.replaceState(null, '', '/?code=AUTHCODE&state=STATE123');
    // PKCE state must match for the redirect to be accepted.
    sessionStorage.setItem(
      'sorter:cloud:pkce:v1',
      JSON.stringify({ verifier: 'V', state: 'STATE123' }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }),
        { status: 200 },
      ),
    );
    const p = new GoogleDriveProvider();
    await p.handleAuthRedirect();
    expect(window.location.hash).toBe('#share=eyJraW5kIjoicmFua2luZyJ9');
    // Stash is single-use — restoration clears the sessionStorage entry
    // so a subsequent boot doesn't replay it.
    expect(sessionStorage.getItem('sorter:preAuthHash')).toBeNull();
  });

  it('restores the stashed hash even on an OAuth error (user denied consent)', async () => {
    sessionStorage.setItem('sorter:preAuthHash', '#share=ABC');
    window.history.replaceState(null, '', '/?error=access_denied&state=STATE123');
    sessionStorage.setItem(
      'sorter:cloud:pkce:v1',
      JSON.stringify({ verifier: 'V', state: 'STATE123' }),
    );
    const p = new GoogleDriveProvider();
    await p.handleAuthRedirect();
    expect(window.location.hash).toBe('#share=ABC');
  });

  it('does NOT touch the URL when there are no auth params (boot bounce-through)', async () => {
    sessionStorage.setItem('sorter:preAuthHash', '#share=SHOULDNT_RESTORE');
    window.history.replaceState(null, '', '/');
    const p = new GoogleDriveProvider();
    await p.handleAuthRedirect();
    expect(window.location.hash).toBe('');
    // The stash should be left in place since no redirect happened.
    expect(sessionStorage.getItem('sorter:preAuthHash')).toBe('#share=SHOULDNT_RESTORE');
  });
});

describe('GoogleDriveProvider.pushSlot', () => {
  /**
   * pushSlot uses Google's "resumable" upload pattern: an init call
   * to /upload/drive/v3/files (POST for create, PATCH for update)
   * with metadata in a JSON body and an X-Upload-Content-* header
   * pair describing the content to come, then a PUT to the Location
   * URL the init response returns. This is the only browser-friendly
   * upload path Google supports — multipart/related triggers a CORS
   * issue (response gets stripped by an edge proxy) and the
   * non-upload create endpoint (POST /drive/v3/files) creates files
   * that drive.file scope refuses subsequent uploads to.
   *
   * Helpers below set the auth + folder state that pushSlot reads
   * before issuing either call. expiresAt is bumped well outside the
   * 60s refresh window so refreshTokenIfNeeded doesn't make an
   * unmocked fetch.
   */
  function setupSignedInWithFolder(): void {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    localStorage.setItem(
      'sorter:cloud:folder:v1',
      JSON.stringify({ folderId: 'FOLDER', folderName: 'Backups' }),
    );
  }

  /** Init response: 200 OK with Location header pointing to the upload URL. */
  function initResp(uploadUrl: string): Response {
    return new Response('', {
      status: 200,
      headers: { location: uploadUrl },
    });
  }

  /** Content PUT response: 200 OK with the file metadata JSON. */
  function contentResp(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('refuses to push when no folder is picked', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    const p = new GoogleDriveProvider();
    await expect(
      p.pushSlot(null, makeBlob(), {
        desiredFilename: 'X.sorter.json',
        sorterSlotId: 'X',
        displayName: 'X',
      }),
    ).rejects.toThrow(/Pick a cloud folder/);
  });

  it('first push (cloudId === null) POSTs init with parents, then PUTs content to the Location URL', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResp('https://www.googleapis.com/upload/drive/v3/files?upload_id=SESSION1'))
      .mockResolvedValueOnce(
        contentResp({ id: 'NEWDRIVEID', modifiedTime: '2026-05-20T01:00:00.000Z', version: '1' }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot(null, makeBlob(7), {
      desiredFilename: 'Movies_abc.sorter.json',
      sorterSlotId: 'abc',
      displayName: 'Movies',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Init: POST to /upload/drive/v3/files?uploadType=resumable, with
    // the X-Upload-Content-* headers and metadata JSON body.
    const [initUrl, initInit] = fetchSpy.mock.calls[0];
    expect(String(initUrl)).toContain('/upload/drive/v3/files?uploadType=resumable');
    expect((initInit as RequestInit | undefined)?.method).toBe('POST');
    const initHeaders = new Headers((initInit as RequestInit | undefined)?.headers);
    expect(initHeaders.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(initHeaders.get('x-upload-content-type')).toBe('application/json');
    expect(initHeaders.get('x-upload-content-length')).toMatch(/^\d+$/);
    const initBody = String((initInit as RequestInit | undefined)?.body ?? '');
    expect(initBody).toContain('"parents":["FOLDER"]');
    expect(initBody).toContain('"name":"Movies_abc.sorter.json"');
    expect(initBody).toContain('"sorterSlotId":"abc"');
    expect(initBody).toContain('"sorterDisplayName":"Movies"');

    // Content: PUT to the Location URL returned by init. Body is the
    // file content JSON.
    const [contentUrl, contentInit] = fetchSpy.mock.calls[1];
    expect(String(contentUrl)).toBe(
      'https://www.googleapis.com/upload/drive/v3/files?upload_id=SESSION1',
    );
    expect((contentInit as RequestInit | undefined)?.method).toBe('PUT');

    expect(result).toEqual({
      cloudId: 'NEWDRIVEID',
      etag: '1',
      updatedAt: '2026-05-20T01:00:00.000Z',
    });
  });

  it('update (cloudId set) PATCHes init at the existing file id, then PUTs content', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files/OLDDRIVEID?upload_id=SESSION2'),
      )
      .mockResolvedValueOnce(
        contentResp({ id: 'OLDDRIVEID', modifiedTime: '2026-05-20T02:00:00.000Z', version: '8' }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot('OLDDRIVEID', makeBlob(11), {
      desiredFilename: 'Movies_abc.sorter.json',
      sorterSlotId: 'abc',
      displayName: 'Movies',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [initUrl, initInit] = fetchSpy.mock.calls[0];
    expect(String(initUrl)).toContain(
      '/upload/drive/v3/files/OLDDRIVEID?uploadType=resumable',
    );
    expect((initInit as RequestInit | undefined)?.method).toBe('PATCH');
    const initBody = String((initInit as RequestInit | undefined)?.body ?? '');
    // parents must NOT be sent on update — Drive would re-parent the
    // file (and we want to preserve the user's folder choice).
    expect(initBody).not.toContain('parents');
    expect(initBody).toContain('"name":"Movies_abc.sorter.json"');

    expect(result.cloudId).toBe('OLDDRIVEID');
    expect(result.etag).toBe('8');
  });

  it('strips the undo ring before uploading the body', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files/X?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({ id: 'X', modifiedTime: '2026-05-20T00:00:00.000Z', version: '1' }),
      );
    const blobWithUndo: AutosaveBlob = {
      ...makeBlob(7),
      undoRing: [makeProgress(5), makeProgress(6)],
    };
    const p = new GoogleDriveProvider();
    await p.pushSlot('X', blobWithUndo, {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
    });
    // Undo ring should be stripped from the uploaded content (PUT,
    // second call) — NOT shipped to the cloud.
    const uploadBody = String((fetchSpy.mock.calls[1][1] as RequestInit | undefined)?.body ?? '');
    expect(uploadBody).toMatch(/"undoRing":\s*\[\]/);
    expect(uploadBody).not.toMatch(/"undoRing":\s*\[\s*\{/);
  });

  it('always sends the desired filename on update so renames sync (locked: app is source of truth)', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files/X?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({ id: 'X', modifiedTime: '2026-05-20T00:00:00.000Z', version: '2' }),
      );
    const p = new GoogleDriveProvider();
    await p.pushSlot('X', makeBlob(), {
      desiredFilename: 'NewName_abc.sorter.json',
      sorterSlotId: 'abc',
      displayName: 'NewName',
    });
    // Filename is in the init metadata body (first call).
    const initBody = String((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.body ?? '');
    expect(initBody).toContain('"name":"NewName_abc.sorter.json"');
  });

  it('falls back to create-new on a 404 init (Drive-side delete recovery)', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // Call 1: PATCH init against the stale id → 404
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // Call 2: recursive POST init → returns fresh upload URL
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files?upload_id=NEW'),
      )
      // Call 3: PUT content → returns the fresh file metadata
      .mockResolvedValueOnce(
        contentResp({ id: 'FRESHID', modifiedTime: '2026-05-20T03:00:00.000Z', version: '1' }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot('STALEID', makeBlob(), {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.method).toBe('PATCH');
    expect((fetchSpy.mock.calls[1][1] as RequestInit | undefined)?.method).toBe('POST');
    expect((fetchSpy.mock.calls[2][1] as RequestInit | undefined)?.method).toBe('PUT');
    expect(result.cloudId).toBe('FRESHID');
  });

  it('uses md5Checksum as the etag when Drive returns one (push response carries content hash)', async () => {
    setupSignedInWithFolder();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({
          id: 'X',
          modifiedTime: '2026-05-20T00:00:00.000Z',
          version: '50',
          md5Checksum: 'content-md5',
        }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot(null, makeBlob(), {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
    });
    expect(result.etag).toBe('content-md5');
  });

  it('does NOT raise a false-positive mismatch when md5 matches but version was bumped by Drive post-processing', async () => {
    // Regression for the "push, push again with no local changes →
    // CloudPushConflictModal appeared" bug. Cause: Drive bumps the
    // `version` field after a successful upload (metadata commit /
    // label indexing) even when the content didn't change. The local
    // cloudEtag stored from the previous push response shows v50; the
    // pre-Push peekEtag GET now returns v51, and a `version`-only
    // comparison would (incorrectly) think someone else wrote to the
    // file. Switching to md5Checksum sidesteps the issue because md5
    // is content-derived — it only changes when bytes change.
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // peekEtag: same md5 as the caller stored, but version is
        // ahead (simulating Drive's post-upload bump).
        contentResp({
          md5Checksum: 'unchanged-md5',
          version: '51',
          modifiedTime: '2026-05-20T05:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files/X?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({
          id: 'X',
          modifiedTime: '2026-05-20T05:00:30.000Z',
          version: '52',
          md5Checksum: 'unchanged-md5',
        }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot('X', makeBlob(), {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
      expectedEtag: 'unchanged-md5', // local stored md5 from prior push
    });
    // No throw — push proceeded normally. Should have made 3 fetch
    // calls (peek + init + content) — never bailed out via the
    // CloudEtagMismatchError path.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.etag).toBe('unchanged-md5');
  });

  it('throws CloudEtagMismatchError when expectedEtag does not match the server etag', async () => {
    setupSignedInWithFolder();
    // Only the peekEtag call should fire — pushSlot throws before
    // touching the init or content PUT.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      contentResp({ version: '9', modifiedTime: '2026-05-20T05:00:00.000Z' }),
    );
    const p = new GoogleDriveProvider();
    await expect(
      p.pushSlot('X', makeBlob(), {
        desiredFilename: 'X.sorter.json',
        sorterSlotId: 'X',
        displayName: 'X',
        expectedEtag: '7', // local thinks cloud is at v7
      }),
    ).rejects.toMatchObject({ name: 'CloudEtagMismatchError', serverEtag: '9', expectedEtag: '7' });
  });

  it('proceeds with init + content PUT when expectedEtag matches the server etag', async () => {
    setupSignedInWithFolder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        contentResp({ version: '7', modifiedTime: '2026-05-20T05:00:00.000Z' }),
      )
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files/X?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({ id: 'X', modifiedTime: '2026-05-20T05:00:30.000Z', version: '8' }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot('X', makeBlob(), {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
      expectedEtag: '7',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.etag).toBe('8');
  });

  it('falls back to create-new when the etag pre-check returns 404 (file deleted upstream)', async () => {
    setupSignedInWithFolder();
    vi.spyOn(globalThis, 'fetch')
      // peekEtag 404 → cloudId is dropped to null, fall through to
      // the create path (init POST, then PUT content).
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(
        initResp('https://www.googleapis.com/upload/drive/v3/files?upload_id=S'),
      )
      .mockResolvedValueOnce(
        contentResp({ id: 'NEW', modifiedTime: '2026-05-20T06:00:00.000Z', version: '1' }),
      );
    const p = new GoogleDriveProvider();
    const result = await p.pushSlot('STALE', makeBlob(), {
      desiredFilename: 'X.sorter.json',
      sorterSlotId: 'X',
      displayName: 'X',
      expectedEtag: '5',
    });
    expect(result.cloudId).toBe('NEW');
  });
});

describe('GoogleDriveProvider.removeCloudSlot', () => {
  it('issues a DELETE and resolves on 204 No Content', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    // Response body must be null for 204 No Content per Fetch spec.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const p = new GoogleDriveProvider();
    await p.removeCloudSlot('DELETEME');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/files/DELETEME');
    expect((init as RequestInit | undefined)?.method).toBe('DELETE');
  });

  it('resolves silently on 404 (file already gone is the desired end state)', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));
    const p = new GoogleDriveProvider();
    await expect(p.removeCloudSlot('GONE')).resolves.toBeUndefined();
  });

  it('throws on non-404 failures', async () => {
    localStorage.setItem(
      'sorter:cloud:tokens:v1',
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 30 * 60_000 }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('forbidden', { status: 403 }));
    const p = new GoogleDriveProvider();
    await expect(p.removeCloudSlot('X')).rejects.toThrow(/removeCloudSlot failed/);
  });
});

// AUTOSAVE_DEBOUNCE_MS is imported so the seam test can wait an actual
// debounce window in the case where we want the timer path instead of
// the synchronous flush. Reference here to keep the import alive in
// case future tests use it directly.
void AUTOSAVE_DEBOUNCE_MS;
