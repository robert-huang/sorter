import type { CloudMenuStatus } from './SettingsMenu';

export interface CloudBackupSectionProps {
  status: CloudMenuStatus;
  folderName?: string;
  onSignIn: () => void;
  onPickFolder: () => void;
  onSignOut: () => void;
  /** When false, hides Browse cloud library (e.g. standalone A2A page). */
  showBrowse?: boolean;
  onBrowse?: () => void;
  /** When false, hides the 'ready'-tier account controls (Change cloud
   *  folder / Sign out of cloud). The gear menu sets this so those two
   *  live in the shared footer across tabs instead of the Slots tab. */
  showAccountControls?: boolean;
}

/**
 * Cloud backup section inside the gear menu. Renders different entries
 * per `status` tier so the user always has exactly one obvious next
 * step.
 */
export function CloudBackupSection({
  status,
  folderName,
  onSignIn,
  onPickFolder,
  onBrowse,
  onSignOut,
  showBrowse = true,
  showAccountControls = true,
}: CloudBackupSectionProps) {
  if (status === 'signed-out' || status === 'expired') {
    return (
      <>
        {status === 'expired' && (
          <div
            className="settings-status"
            style={{ color: 'var(--text-warn, var(--text-muted))' }}
          >
            Cloud session expired &mdash; please sign in again.
          </div>
        )}
        <button type="button" className="settings-item" onClick={onSignIn}>
          Sign in to cloud backup&hellip;
        </button>
      </>
    );
  }
  if (status === 'needs-folder') {
    return (
      <>
        <div className="settings-status">
          Cloud sign-in complete. Pick a Drive folder to store your backups.
        </div>
        <button type="button" className="settings-item primary" onClick={onPickFolder}>
          Pick cloud folder&hellip;
        </button>
        <button type="button" className="settings-item" onClick={onSignOut}>
          Sign out of cloud
        </button>
      </>
    );
  }
  // ready
  return (
    <>
      {showBrowse && onBrowse && (
        <button type="button" className="settings-item" onClick={onBrowse}>
          Browse cloud library&hellip;
          {folderName && (
            <span className="settings-item-hint" title={folderName}>
              {' '}
              ({folderName})
            </span>
          )}
        </button>
      )}
      {showAccountControls && (
        <>
          <button type="button" className="settings-item" onClick={onPickFolder}>
            Change cloud folder&hellip;
          </button>
          <button type="button" className="settings-item" onClick={onSignOut}>
            Sign out of cloud
          </button>
        </>
      )}
    </>
  );
}
