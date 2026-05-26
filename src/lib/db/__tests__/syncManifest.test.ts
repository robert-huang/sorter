import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCRAPE_LOCK_STALE_MS,
  _clearDbSyncManifestForTesting,
  acquireScrapeLock,
  bumpPendingChanges,
  clearPendingChanges,
  getPendingChanges,
  getSourceSyncMeta,
  patchSourceSyncMeta,
  refreshScrapeLock,
  releaseScrapeLock,
} from '../syncManifest';

const SOURCE = 'lock-test';
const T0 = 1_700_000_000_000;

beforeEach(() => {
  _clearDbSyncManifestForTesting();
});

afterEach(() => {
  _clearDbSyncManifestForTesting();
});

describe('SourceSyncMeta back-compat', () => {
  it('defaults scrapeLock to null when reading a legacy manifest entry without the field', () => {
    // Simulate a legacy entry by patching only the pre-existing fields. The
    // raw localStorage entry will be missing scrapeLock; getSourceSyncMeta
    // should default-fill on read.
    patchSourceSyncMeta(SOURCE, { remoteEtag: 'etag-1', hasLocalDb: true });
    // Strip scrapeLock from localStorage to recreate the pre-migration shape.
    const raw = JSON.parse(localStorage.getItem('sorter:db-sync:v1') ?? '{}') as {
      sources: Record<string, Record<string, unknown>>;
    };
    delete raw.sources[SOURCE].scrapeLock;
    localStorage.setItem('sorter:db-sync:v1', JSON.stringify(raw));

    const meta = getSourceSyncMeta(SOURCE);
    expect(meta.scrapeLock).toBeNull();
    expect(meta.remoteEtag).toBe('etag-1');
    expect(meta.hasLocalDb).toBe(true);
  });
});

describe('acquireScrapeLock', () => {
  it('returns a token and persists the lock when no lock is held', () => {
    const result = acquireScrapeLock(SOURCE, T0);
    expect(result).not.toBeNull();
    expect(typeof result!.token).toBe('string');

    const meta = getSourceSyncMeta(SOURCE);
    expect(meta.scrapeLock).not.toBeNull();
    expect(meta.scrapeLock!.token).toBe(result!.token);
    expect(meta.scrapeLock!.heldSince).toBe(T0);
    expect(meta.scrapeLock!.lastActivity).toBe(T0);
  });

  it('returns null when a fresh lock is held by another caller', () => {
    const first = acquireScrapeLock(SOURCE, T0);
    expect(first).not.toBeNull();

    const second = acquireScrapeLock(SOURCE, T0 + 60_000);
    expect(second).toBeNull();
    // The original lock should still be in place — second acquire must not
    // overwrite the lock or bump its timestamp.
    const meta = getSourceSyncMeta(SOURCE);
    expect(meta.scrapeLock!.token).toBe(first!.token);
    expect(meta.scrapeLock!.lastActivity).toBe(T0);
  });

  it('replaces a stale lock and issues a new token (crashed-tab takeover)', () => {
    const first = acquireScrapeLock(SOURCE, T0);
    const staleAt = T0 + SCRAPE_LOCK_STALE_MS;
    const second = acquireScrapeLock(SOURCE, staleAt);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);

    const meta = getSourceSyncMeta(SOURCE);
    expect(meta.scrapeLock!.token).toBe(second!.token);
    expect(meta.scrapeLock!.heldSince).toBe(staleAt);
  });

  it('does not consider a lock stale before the exact stale boundary', () => {
    acquireScrapeLock(SOURCE, T0);
    // One ms before the stale boundary: still held.
    const justBefore = acquireScrapeLock(SOURCE, T0 + SCRAPE_LOCK_STALE_MS - 1);
    expect(justBefore).toBeNull();
  });
});

describe('refreshScrapeLock', () => {
  it('returns true and bumps lastActivity when the token matches', () => {
    const first = acquireScrapeLock(SOURCE, T0)!;
    const ok = refreshScrapeLock(SOURCE, first.token, T0 + 30_000);
    expect(ok).toBe(true);
    const meta = getSourceSyncMeta(SOURCE);
    expect(meta.scrapeLock!.lastActivity).toBe(T0 + 30_000);
    expect(meta.scrapeLock!.heldSince).toBe(T0); // unchanged
  });

  it('returns false when no lock is held', () => {
    expect(refreshScrapeLock(SOURCE, 'bogus-token', T0)).toBe(false);
  });

  it('returns false when the lock token does not match the caller', () => {
    acquireScrapeLock(SOURCE, T0);
    const ok = refreshScrapeLock(SOURCE, 'wrong-token', T0 + 10_000);
    expect(ok).toBe(false);
    // The real lock's lastActivity must NOT be bumped by a foreign refresh.
    expect(getSourceSyncMeta(SOURCE).scrapeLock!.lastActivity).toBe(T0);
  });

  it('keeps a long-running scrape alive past the stale window', () => {
    const first = acquireScrapeLock(SOURCE, T0)!;
    // Refresh every minute — total elapsed exceeds SCRAPE_LOCK_STALE_MS
    // but the lock stays fresh.
    for (let t = 60_000; t <= SCRAPE_LOCK_STALE_MS * 2; t += 60_000) {
      expect(refreshScrapeLock(SOURCE, first.token, T0 + t)).toBe(true);
    }
    // Now another tab tries to acquire just 1ms after the last refresh;
    // should still see a fresh lock.
    const other = acquireScrapeLock(SOURCE, T0 + SCRAPE_LOCK_STALE_MS * 2 + 1);
    expect(other).toBeNull();
  });
});

describe('releaseScrapeLock', () => {
  it('clears the lock when the token matches', () => {
    const first = acquireScrapeLock(SOURCE, T0)!;
    releaseScrapeLock(SOURCE, first.token);
    expect(getSourceSyncMeta(SOURCE).scrapeLock).toBeNull();
  });

  it('is a no-op when no lock is held (safe to always finally-release)', () => {
    expect(() => releaseScrapeLock(SOURCE, 'any-token')).not.toThrow();
    expect(getSourceSyncMeta(SOURCE).scrapeLock).toBeNull();
  });

  it('is a no-op when the token does not match — protects another tab\u2019s lock', () => {
    const first = acquireScrapeLock(SOURCE, T0)!;
    releaseScrapeLock(SOURCE, 'wrong-token');
    expect(getSourceSyncMeta(SOURCE).scrapeLock).not.toBeNull();
    expect(getSourceSyncMeta(SOURCE).scrapeLock!.token).toBe(first.token);
  });
});

// Phase D: per-source pendingChanges counter. Bumped by ad-hoc writes
// (e.g. per-entry detail-modal refresh) that skip the auto-push path,
// cleared by the push-success path. The counter is persisted in the
// same localStorage entry as the rest of the meta.
describe('pendingChanges counter', () => {
  it('defaults to 0 for a never-touched source', () => {
    expect(getPendingChanges('never-touched')).toBe(0);
    expect(getSourceSyncMeta('never-touched').pendingChanges).toBe(0);
  });

  it('bumpPendingChanges increments + returns the new value', () => {
    expect(bumpPendingChanges(SOURCE)).toBe(1);
    expect(bumpPendingChanges(SOURCE)).toBe(2);
    expect(bumpPendingChanges(SOURCE)).toBe(3);
    expect(getPendingChanges(SOURCE)).toBe(3);
  });

  it('clearPendingChanges resets to 0 and is idempotent', () => {
    bumpPendingChanges(SOURCE);
    bumpPendingChanges(SOURCE);
    expect(getPendingChanges(SOURCE)).toBe(2);

    clearPendingChanges(SOURCE);
    expect(getPendingChanges(SOURCE)).toBe(0);
    // Re-clearing a 0-counter must not throw or flip to a negative.
    clearPendingChanges(SOURCE);
    expect(getPendingChanges(SOURCE)).toBe(0);
  });

  it('counters are scoped per source (bumping A does not affect B)', () => {
    bumpPendingChanges('source-a');
    bumpPendingChanges('source-a');
    bumpPendingChanges('source-b');
    expect(getPendingChanges('source-a')).toBe(2);
    expect(getPendingChanges('source-b')).toBe(1);
    clearPendingChanges('source-a');
    expect(getPendingChanges('source-a')).toBe(0);
    // Clearing A must leave B untouched.
    expect(getPendingChanges('source-b')).toBe(1);
  });

  it('persists across module re-reads (writes to the manifest, not memory)', () => {
    bumpPendingChanges(SOURCE);
    bumpPendingChanges(SOURCE);
    // Round-trip through localStorage to prove it isn't held only in
    // a module-local cache. getSourceSyncMeta always re-reads.
    const raw = localStorage.getItem('sorter:db-sync:v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { sources: Record<string, { pendingChanges: number }> };
    expect(parsed.sources[SOURCE].pendingChanges).toBe(2);
  });

  it('legacy manifest entry (missing pendingChanges field) reads as 0', () => {
    // Build a SourceSyncMeta with everything except pendingChanges.
    patchSourceSyncMeta(SOURCE, { remoteEtag: 'etag-1', hasLocalDb: true });
    const raw = JSON.parse(localStorage.getItem('sorter:db-sync:v1') ?? '{}') as {
      sources: Record<string, Record<string, unknown>>;
    };
    delete raw.sources[SOURCE].pendingChanges;
    localStorage.setItem('sorter:db-sync:v1', JSON.stringify(raw));

    expect(getPendingChanges(SOURCE)).toBe(0);
    // First bump after default-fill should land at 1, not NaN.
    expect(bumpPendingChanges(SOURCE)).toBe(1);
  });
});
