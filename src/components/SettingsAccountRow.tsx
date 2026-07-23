import type { ReactNode } from 'react';
import { LogOutIcon } from './icons';

interface Props {
  children: ReactNode;
  onSignOut: () => void;
  /** Accessible name for the sign-out control (e.g. "Sign out @alice"). */
  signOutLabel: string;
}

/** Account identity row with an inline sign-out icon on the right. */
export function SettingsAccountRow({ children, onSignOut, signOutLabel }: Props) {
  return (
    <div className="settings-account-row">
      <div className="settings-account-row-main">{children}</div>
      <button
        type="button"
        className="settings-account-sign-out"
        onClick={onSignOut}
        aria-label={signOutLabel}
        title={signOutLabel}
      >
        <LogOutIcon size={14} />
        <span className="settings-account-sign-out-label">Logout</span>
      </button>
    </div>
  );
}
