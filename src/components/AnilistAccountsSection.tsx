import { useCallback, useEffect, useState } from 'react';
import {
  getAnilistOAuthCallbackUrl,
  isAnilistOAuthConfigured,
  listAnilistAccounts,
  signInToAnilist,
  signOutAnilistAccount,
  subscribeAnilistAccounts,
  type AnilistStoredAccount,
} from '../lib/importers/anilist/anilistAuth';

function formatExpiry(expiresAt: number): string {
  try {
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'unknown';
  }
}

function accountStatusLabel(account: AnilistStoredAccount): string | null {
  if (account.status === 'expired') {
    return 'expired';
  }
  if (account.status === 'invalid') {
    return 'invalid';
  }
  if (Date.now() >= account.expiresAt) {
    return 'expired';
  }
  return null;
}

/**
 * AniList account manager for the gear menu Databases tab. Supports
 * multiple stored accounts; list imports for logged-in usernames use OAuth.
 */
export function AnilistAccountsSection() {
  const [accounts, setAccounts] = useState<AnilistStoredAccount[]>(() =>
    listAnilistAccounts(),
  );
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    return subscribeAnilistAccounts(() => {
      setAccounts(listAnilistAccounts());
    });
  }, []);

  const onSignIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      await signInToAnilist();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AniList sign-in failed');
    } finally {
      setSigningIn(false);
    }
  }, []);

  const onSignOut = useCallback((userId: number) => {
    signOutAnilistAccount(userId);
  }, []);

  const configured = isAnilistOAuthConfigured();
  const callbackUrl = getAnilistOAuthCallbackUrl();

  return (
    <>
      <div className="settings-status settings-section-label">AniList accounts</div>
      {!configured && (
        <div className="settings-status" style={{ color: 'var(--text-muted)' }}>
          AniList sign-in is not configured for this build (
          <code>VITE_ANILIST_CLIENT_ID</code>).
        </div>
      )}
      {configured && (
        <div className="settings-status settings-item-hint">
          One-time AniList setup: register redirect URL{' '}
          <code style={{ wordBreak: 'break-all' }}>{callbackUrl}</code> on your API client.
        </div>
      )}
      {accounts.length === 0 ? (
        <div className="settings-status" style={{ color: 'var(--text-muted)' }}>
          No AniList accounts signed in.
        </div>
      ) : (
        accounts.map((account) => {
          const badge = accountStatusLabel(account);
          return (
            <div key={account.userId}>
              <div
                className="settings-status"
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                {account.avatarUrl ? (
                  <img
                    src={account.avatarUrl}
                    alt=""
                    width={24}
                    height={24}
                    style={{ borderRadius: '50%' }}
                  />
                ) : null}
                <span>
                  @{account.userName}
                  <span className="settings-item-hint">
                    {' '}
                    · expires {formatExpiry(account.expiresAt)}
                    {badge ? ` · ${badge}` : ''}
                  </span>
                </span>
              </div>
              {badge && configured && (
                <button
                  type="button"
                  className="settings-item"
                  disabled={signingIn}
                  onClick={() => void onSignIn()}
                >
                  Re-login @{account.userName}
                </button>
              )}
              <button
                type="button"
                className="settings-item"
                onClick={() => onSignOut(account.userId)}
              >
                Sign out @{account.userName}
              </button>
            </div>
          );
        })
      )}
      {configured && (
        <button
          type="button"
          className="settings-item"
          disabled={signingIn}
          onClick={() => void onSignIn()}
        >
          {signingIn ? 'Waiting for AniList…' : 'Sign in to AniList…'}
        </button>
      )}
      <div className="settings-status settings-item-hint">
        Opens AniList in a pop-up, then returns automatically. List imports for
        logged-in accounts include hidden entries. Other usernames still use public
        lists.
      </div>
      {error && (
        <div className="settings-source-db-error" role="alert">
          {error}
        </div>
      )}
      <div className="settings-divider" />
    </>
  );
}
