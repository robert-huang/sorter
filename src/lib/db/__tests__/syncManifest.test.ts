import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCRAPE_LOCK_STALE_MS,
  _clearDbSyncManifestForTesting,
  acquireScrapeLock,
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
