import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOpfsSecureContext } from '../opfs';

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
