import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseOpfsSahPool,
  describeNonPersistentStorageBanner,
  describeOpfsBlockedReason,
  isCrossOriginIsolated,
  isOpfsSecureContext,
} from '../opfs';

describe('describeNonPersistentStorageBanner', () => {
  it('names another tab when the OPFS lock is contended (A2A)', () => {
    expect(
      describeNonPersistentStorageBanner({
        reason: 'other_tab',
        context: 'a2a',
      }),
    ).toContain('Another Sorter tab');
  });

  it('names another tab when the OPFS lock is contended (Sorter)', () => {
    expect(
      describeNonPersistentStorageBanner({
        reason: 'other_tab',
        context: 'sorter',
      }),
    ).toContain('Close other Sorter / Anime to Anime tabs');
  });
});

describe('isOpfsSecureContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when isSecureContext is false', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(isOpfsSecureContext()).toBe(false);
  });

  it('returns true when isSecureContext is true', () => {
    vi.stubGlobal('isSecureContext', true);
    expect(isOpfsSecureContext()).toBe(true);
  });

  it('returns false when isSecureContext is undefined', () => {
    vi.stubGlobal('isSecureContext', undefined);
    expect(isOpfsSecureContext()).toBe(false);
  });
});

describe('canUseOpfsSahPool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not require cross-origin isolation when OPFS APIs exist', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('FileSystemFileHandle', {
      prototype: { createSyncAccessHandle: () => ({}) },
    });
    expect(isCrossOriginIsolated()).toBe(false);
    expect(canUseOpfsSahPool()).toBe(true);
  });

  it('requires secure context and sync access handle API', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('FileSystemFileHandle', {
      prototype: { createSyncAccessHandle: () => ({}) },
    });
    expect(canUseOpfsSahPool()).toBe(false);
    expect(describeOpfsBlockedReason()).toContain('secure context');
  });

  it('returns true when all OPFS prerequisites are met', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('FileSystemFileHandle', {
      prototype: { createSyncAccessHandle: () => ({}) },
    });
    expect(canUseOpfsSahPool()).toBe(true);
  });
});
