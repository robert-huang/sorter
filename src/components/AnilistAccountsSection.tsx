import { useCallback, useEffect, useState } from 'react';
import { SettingsAccountRow } from './SettingsAccountRow';
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
  const showDevSetup = import.meta.env.DEV && configured;

  return (
    <div className="settings-anilist-accounts">
      <div className="settings-status settings-section-label">AniList accounts</div>
      {!configured && (
        <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
          AniList sign-in is not configured for this build (
          <code>VITE_ANILIST_CLIENT_ID</code>).
        </div>
      )}
      {showDevSetup && (
        <div className="settings-status settings-anilist-hint">
          Dev setup: register redirect URL{' '}
          <code>{callbackUrl}</code> on your AniList API client.
        </div>
      )}
      {accounts.length === 0 ? (
        <div className="settings-status settings-anilist-hint" style={{ color: 'var(--text-muted)' }}>
          No AniList accounts signed in.
        </div>
      ) : (
        accounts.map((account) => {
          const badge = accountStatusLabel(account);
          return (
            <div key={account.userId}>
              <SettingsAccountRow
                onSignOut={() => onSignOut(account.userId)}
                signOutLabel={`Sign out @${account.userName}`}
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
              </SettingsAccountRow>
              {badge && configured && (
                <button
                  type="button"
                  className="settings-item settings-item-status-text"
                  disabled={signingIn}
                  onClick={() => void onSignIn()}
                >
                  Re-login @{account.userName}
                </button>
              )}
            </div>
          );
        })
      )}
      {configured && (
        <button
          type="button"
          className="settings-item settings-item-status-text"
          disabled={signingIn}
          onClick={() => void onSignIn()}
        >
          {signingIn ? 'Waiting for AniList…' : 'Sign in to AniList…'}
        </button>
      )}
      <div className="settings-status settings-anilist-hint">
        Opens AniList in a pop-up, then auto-returns. Signed-in accounts
        can import hidden list entries and enables mutations.
      </div>
      {error && (
        <div className="settings-source-db-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
