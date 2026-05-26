/**
 * Coverage for the tiny localStorage-backed username history helper
 * used by the AniList start screen's `<datalist>` fallback. Vitest +
 * jsdom give us a real `localStorage` so the safe-read/safe-write
 * wrappers are exercised exactly as they would be in the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addUsernameToHistory,
  clearUsernameHistory,
  loadUsernameHistory,
  removeUsernameFromHistory,
} from '../usernameHistory';

const KEY = 'test:usernameHistory';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadUsernameHistory', () => {
  it('returns an empty array for a fresh storage key', () => {
    expect(loadUsernameHistory(KEY)).toEqual([]);
  });

  it('returns the parsed array when storage holds a valid JSON list of strings', () => {
    localStorage.setItem(KEY, JSON.stringify(['alice', 'bob']));
    expect(loadUsernameHistory(KEY)).toEqual(['alice', 'bob']);
  });

  it('filters out non-string and empty entries from a corrupted payload', () => {
    // Defensive: an external script (or a buggy older version) might
    // have written junk into our key. The helper must still return a
    // usable string[] so the <datalist> renders.
    localStorage.setItem(
      KEY,
      JSON.stringify(['alice', 42, '', '   ', null, 'bob']),
    );
    expect(loadUsernameHistory(KEY)).toEqual(['alice', 'bob']);
  });

  it('returns an empty array when the stored value is not valid JSON', () => {
    localStorage.setItem(KEY, 'not-a-json-array');
    expect(loadUsernameHistory(KEY)).toEqual([]);
  });

  it('returns an empty array when the stored value parses to a non-array', () => {
    localStorage.setItem(KEY, JSON.stringify({ alice: true }));
    expect(loadUsernameHistory(KEY)).toEqual([]);
  });
});

describe('addUsernameToHistory', () => {
  it('appends a brand-new entry at the front (most-recent-first ordering)', () => {
    addUsernameToHistory(KEY, 'alice');
    const next = addUsernameToHistory(KEY, 'bob');
    expect(next).toEqual(['bob', 'alice']);
    expect(loadUsernameHistory(KEY)).toEqual(['bob', 'alice']);
  });

  it('deduplicates by case-sensitive equality so re-typing an entry moves it to the front', () => {
    // AniList usernames are case-sensitive — 'Robert' and 'robert'
    // are distinct accounts on the platform, so the local history
    // must preserve case-sensitive identity.
    addUsernameToHistory(KEY, 'alice');
    addUsernameToHistory(KEY, 'bob');
    const next = addUsernameToHistory(KEY, 'alice');
    expect(next).toEqual(['alice', 'bob']);
  });

  it('treats different-case entries as distinct', () => {
    addUsernameToHistory(KEY, 'Robert');
    const next = addUsernameToHistory(KEY, 'robert');
    expect(next).toEqual(['robert', 'Robert']);
  });

  it('trims whitespace before storing (paste-from-clipboard friendly)', () => {
    const next = addUsernameToHistory(KEY, '  alice  \n');
    expect(next).toEqual(['alice']);
  });

  it('is a no-op for empty/whitespace-only input', () => {
    addUsernameToHistory(KEY, 'alice');
    addUsernameToHistory(KEY, '');
    addUsernameToHistory(KEY, '   ');
    expect(loadUsernameHistory(KEY)).toEqual(['alice']);
  });

  it('caps the stored list at 12 entries (drops the oldest)', () => {
    for (let i = 0; i < 15; i++) {
      addUsernameToHistory(KEY, `u${i}`);
    }
    const stored = loadUsernameHistory(KEY);
    expect(stored).toHaveLength(12);
    // Most-recent first: u14, u13, u12, ..., u3. u0/u1/u2 dropped.
    expect(stored[0]).toBe('u14');
    expect(stored[11]).toBe('u3');
    expect(stored).not.toContain('u0');
    expect(stored).not.toContain('u1');
    expect(stored).not.toContain('u2');
  });

  it('survives localStorage write failures (returns previous value as fallback)', () => {
    addUsernameToHistory(KEY, 'alice');
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    setSpy.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // No throw, no crash — the helper swallows the error so the
    // input doesn't lock up.
    expect(() => addUsernameToHistory(KEY, 'bob')).not.toThrow();
  });
});

describe('removeUsernameFromHistory', () => {
  it('removes a single matching entry and preserves order of the rest', () => {
    addUsernameToHistory(KEY, 'alice');
    addUsernameToHistory(KEY, 'bob');
    addUsernameToHistory(KEY, 'carol');
    const next = removeUsernameFromHistory(KEY, 'bob');
    expect(next).toEqual(['carol', 'alice']);
  });

  it('returns the original list when the value is not present (no spurious write)', () => {
    addUsernameToHistory(KEY, 'alice');
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    const next = removeUsernameFromHistory(KEY, 'unknown');
    expect(next).toEqual(['alice']);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('clearUsernameHistory', () => {
  it('wipes the stored list so subsequent loads return empty', () => {
    addUsernameToHistory(KEY, 'alice');
    addUsernameToHistory(KEY, 'bob');
    clearUsernameHistory(KEY);
    expect(loadUsernameHistory(KEY)).toEqual([]);
  });

  it('is a no-op when there is nothing to clear', () => {
    expect(() => clearUsernameHistory(KEY)).not.toThrow();
    expect(loadUsernameHistory(KEY)).toEqual([]);
  });
});
