interface ToolRunButtonProps {
  label: string;
  running: boolean;
  disabled?: boolean;
  onRun: (forceRefresh: boolean) => void;
  /** Shown on the button; right-click forces a live AniList re-fetch. */
  forceRefreshTitle?: string;
}

const DEFAULT_FORCE_TITLE =
  'Right-click to re-fetch from AniList (bypass cache)';

export function ToolRunButton({
  label,
  running,
  disabled = false,
  onRun,
  forceRefreshTitle = DEFAULT_FORCE_TITLE,
}: ToolRunButtonProps) {
  const busy = running || disabled;
  const title = busy ? undefined : forceRefreshTitle;

  // Left-click submits the parent form (`type="submit"`), which invokes onRun via
  // the form's onSubmit handler. Right-click bypasses the form to force refresh.
  return (
    <button
      type="submit"
      className="btn primary"
      disabled={busy}
      title={title}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!busy) {
          onRun(true);
        }
      }}
    >
      {running ? 'Running…' : label}
    </button>
  );
}
