interface Props {
  title: string;
  onRefresh: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
}

export function PlayListSectionHeader({
  title,
  onRefresh,
  refreshing = false,
  refreshLabel = 'Refresh list from AniList',
}: Props) {
  return (
    <div className="anime-to-anime-list-header">
      <h3 className="anime-to-anime-subheading anime-to-anime-list-header-title">{title}</h3>
      <button
        type="button"
        className="btn btn-icon anime-to-anime-refresh-btn"
        onClick={onRefresh}
        disabled={refreshing}
        title={refreshLabel}
        aria-label={refreshLabel}
      >
        ↻
      </button>
    </div>
  );
}
