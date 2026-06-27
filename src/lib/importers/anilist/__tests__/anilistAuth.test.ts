import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnilistAuthRequiredError,
  _clearAnilistAccountsForTesting,
  decodeAnilistOAuthState,
  decodeJwtExpiresAtMs,
  encodeAnilistOAuthState,
  findAnilistAccountByName,
  getAnilistOAuthCallbackOrigin,
  getAnilistOAuthCallbackUrl,
  isAnilistOAuthCallbackMessage,
  listAnilistAccounts,
  markAnilistAccountExpired,
  parseOAuthHashParams,
  parseOAuthQueryParams,
  resolveAccessTokenForUsername,
  requireAccessTokenForUsername,
  signOutAnilistAccount,
} from '../anilistAuth';

const NOW = 1_700_000_000_000;

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.sig`;
}

function seedAccount(overrides: Partial<{
  userId: number;
  userName: string;
  accessToken: string;
  expiresAt: number;
  status: 'ok' | 'expired' | 'invalid';
}> = {}): void {
  const account = {
    userId: 42,
    userName: 'TestUser',
    accessToken: 'token-abc',
    expiresAt: NOW + 60_000,
    addedAt: NOW,
    status: 'ok' as const,
    ...overrides,
  };
  localStorage.setItem('anilist:accounts:v1', JSON.stringify({ accounts: [account] }));
}

beforeEach(() => {
  _clearAnilistAccountsForTesting();
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
  });
});

afterEach(() => {
  _clearAnilistAccountsForTesting();
  vi.unstubAllGlobals();
});

describe('parseOAuthQueryParams', () => {
  it('parses code and state from a query string', () => {
    expect(parseOAuthQueryParams('?code=abc&state=xyz')).toEqual({
      authCode: 'abc',
      error: null,
      state: 'xyz',
    });
  });

  it('returns nulls for an empty query', () => {
    expect(parseOAuthQueryParams('')).toEqual({
      authCode: null,
      error: null,
      state: null,
    });
  });
});

describe('parseOAuthHashParams', () => {
  it('parses access_token from a hash fragment', () => {
    expect(
      parseOAuthHashParams('#access_token=abc123&token_type=Bearer'),
    ).toEqual({
      accessToken: 'abc123',
      tokenType: 'Bearer',
      error: null,
    });
  });

  it('returns nulls for an empty hash', () => {
    expect(parseOAuthHashParams('')).toEqual({
      accessToken: null,
      tokenType: null,
      error: null,
    });
  });
});

describe('decodeJwtExpiresAtMs', () => {
  it('reads exp from JWT payload as seconds → ms', () => {
    const expSec = Math.floor(NOW / 1000) + 3600;
    const token = makeJwt({ exp: expSec });
    expect(decodeJwtExpiresAtMs(token, NOW)).toBe(expSec * 1000);
  });

  it('falls back to ~1 year from addedAt when exp is missing', () => {
    const token = makeJwt({ sub: '1' });
    const result = decodeJwtExpiresAtMs(token, NOW);
    expect(result).toBeGreaterThan(NOW + 364 * 24 * 60 * 60 * 1000);
  });
});

describe('popup OAuth helpers', () => {
  it('round-trips OAuth state through base64url encoding', () => {
    const state = { origin: 'http://localhost:5173', nonce: 'abc123' };
    const encoded = encodeAnilistOAuthState(state);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(decodeAnilistOAuthState(encoded)).toEqual(state);
  });

  it('returns the default hosted callback URL', () => {
    expect(getAnilistOAuthCallbackUrl()).toBe(
      'https://robert-huang.github.io/sorter/anilist-oauth-callback.html',
    );
    expect(getAnilistOAuthCallbackOrigin()).toBe('https://robert-huang.github.io');
  });

  it('recognises postMessage payloads from the callback page', () => {
    expect(
      isAnilistOAuthCallbackMessage({
        type: 'anilist-oauth-callback',
        accessToken: 'tok',
        error: null,
        nonce: 'n',
      }),
    ).toBe(true);
    expect(isAnilistOAuthCallbackMessage({ type: 'other' })).toBe(false);
  });
});

describe('account store', () => {
  it('finds accounts by username case-insensitively', () => {
    seedAccount({ userName: 'MixedCase' });
    expect(findAnilistAccountByName('mixedcase')?.userName).toBe('MixedCase');
  });

  it('marks expired and throws on resolve', () => {
    seedAccount({ expiresAt: NOW - 1 });
    expect(() => resolveAccessTokenForUsername('TestUser')).toThrow(AnilistAuthRequiredError);
    expect(findAnilistAccountByName('TestUser')?.status).toBe('expired');
  });

  it('throws without public fallback when status is invalid', () => {
    seedAccount({ status: 'invalid' });
    expect(() => resolveAccessTokenForUsername('TestUser')).toThrow(AnilistAuthRequiredError);
  });

  it('returns null when no stored account exists', () => {
    expect(resolveAccessTokenForUsername('nobody')).toBeNull();
  });

  it('requireAccessTokenForUsername throws when no stored account exists', () => {
    expect(() => requireAccessTokenForUsername('nobody')).toThrow(AnilistAuthRequiredError);
  });

  it('requireAccessTokenForUsername returns token when account is valid', () => {
    seedAccount({ expiresAt: Date.now() + 60_000 });
    expect(requireAccessTokenForUsername('TestUser')).toBe('token-abc');
  });

  it('upserts by userId via mark expired + sign out', () => {
    seedAccount();
    markAnilistAccountExpired(42);
    expect(listAnilistAccounts()[0].status).toBe('expired');
    signOutAnilistAccount(42);
    expect(listAnilistAccounts()).toHaveLength(0);
  });
});
