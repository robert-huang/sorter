import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseOpfsSahPool,
  describeOpfsBlockedReason,
  isCrossOriginIsolated,
  isOpfsSecureContext,
} from '../opfs';

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

  it('requires cross-origin isolation and sync access handle API', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('FileSystemFileHandle', {
      prototype: { createSyncAccessHandle: () => ({}) },
    });
    expect(canUseOpfsSahPool()).toBe(false);
    expect(describeOpfsBlockedReason()).toContain('COOP/COEP');
  });

  it('returns true when all OPFS prerequisites are met', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('FileSystemFileHandle', {
      prototype: { createSyncAccessHandle: () => ({}) },
    });
    expect(isCrossOriginIsolated()).toBe(true);
    expect(canUseOpfsSahPool()).toBe(true);
  });
});
