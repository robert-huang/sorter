interface Props {
  title: string;
  onRefresh: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
  /** True when the cached data behind this list is older than the
   *  staleness threshold (>90d) — highlights the refresh button to
   *  prompt an update. */
  stale?: boolean;
  /** Tooltip shown in place of refreshLabel while stale. */
  staleRefreshLabel?: string;
}

export function PlayListSectionHeader({
  title,
  onRefresh,
  refreshing = false,
  refreshLabel = 'Refresh list from AniList',
  stale = false,
  staleRefreshLabel,
}: Props) {
  // Don't flag stale while a refresh is in flight — the spinner already
  // signals activity and the cache is about to update.
  const isStale = stale && !refreshing;
  const label = isStale ? (staleRefreshLabel ?? refreshLabel) : refreshLabel;
  return (
    <div className="anime-to-anime-list-header">
      <h3 className="anime-to-anime-subheading anime-to-anime-list-header-title">{title}</h3>
      <button
        type="button"
        className={`btn icon-only anime-to-anime-refresh-btn${
          isStale ? ' anilist-detail-refresh-stale' : ''
        }`}
        onClick={onRefresh}
        disabled={refreshing}
        title={label}
        aria-label={label}
      >
        ↻
      </button>
    </div>
  );
}
