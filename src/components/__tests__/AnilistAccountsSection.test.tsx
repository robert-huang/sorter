import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAnilistOAuthConfigured,
  listAnilistAccounts,
  subscribeAnilistAccounts,
  type AnilistStoredAccount,
} from '../../lib/importers/anilist/anilistAuth';
import { AnilistAccountsSection } from '../AnilistAccountsSection';

vi.mock('../../lib/importers/anilist/anilistAuth', () => ({
  getAnilistOAuthCallbackUrl: vi.fn(() => 'https://example.com/callback'),
  isAnilistOAuthConfigured: vi.fn(() => true),
  listAnilistAccounts: vi.fn(() => []),
  signInToAnilist: vi.fn(async () => undefined),
  signOutAnilistAccount: vi.fn(),
  subscribeAnilistAccounts: vi.fn(() => () => undefined),
}));

vi.mock('../../lib/importers/anilist/lastUsername', () => ({
  readLastAnilistUsername: vi.fn(() => null),
}));

const VALID_ACCOUNT: AnilistStoredAccount = {
  userId: 1,
  userName: 'alice',
  accessToken: 'token',
  expiresAt: Date.now() + 60_000,
  addedAt: Date.now(),
  status: 'ok',
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  vi.mocked(isAnilistOAuthConfigured).mockReturnValue(true);
  vi.mocked(listAnilistAccounts).mockReturnValue([]);
  vi.mocked(subscribeAnilistAccounts).mockReturnValue(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderSection(): void {
  act(() => {
    root.render(<AnilistAccountsSection />);
  });
}

function signInButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.includes('Sign in to AniList'),
  );
}

describe('AnilistAccountsSection', () => {
  it('keeps the sign-in guidance prominent when no account is signed in', () => {
    renderSection();

    expect(container.textContent).toContain(
      'Opens AniList in a pop-up, then auto-returns.',
    );
    expect(
      signInButton()?.classList.contains('settings-anilist-sign-in-secondary'),
    ).toBe(false);
  });

  it('hides pop-up guidance and fades sign-in after an account is signed in', () => {
    vi.mocked(listAnilistAccounts).mockReturnValue([VALID_ACCOUNT]);

    renderSection();

    expect(container.textContent).not.toContain(
      'Opens AniList in a pop-up, then auto-returns.',
    );
    expect(
      signInButton()?.classList.contains('settings-anilist-sign-in-secondary'),
    ).toBe(true);
  });

  it('keeps sign-in guidance prominent when every stored account is expired', () => {
    vi.mocked(listAnilistAccounts).mockReturnValue([
      { ...VALID_ACCOUNT, status: 'expired' },
    ]);

    renderSection();

    expect(container.textContent).toContain(
      'Opens AniList in a pop-up, then auto-returns.',
    );
    expect(
      signInButton()?.classList.contains('settings-anilist-sign-in-secondary'),
    ).toBe(false);
  });
});
