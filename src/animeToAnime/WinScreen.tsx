import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { currentPageUrl } from '../lib/appRoutes';
import { formatPathSummary, type PathStep } from './pathHistory';

interface Props {
  startMedia: MediaRow;
  goalMedia: MediaRow;
  animeHops: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
}

function buildSummaryCopyText(
  startMedia: MediaRow,
  goalMedia: MediaRow,
  animeHops: number,
  pathHistory: readonly PathStep[],
  pageUrl: string,
): string {
  const start = pickMediaTitle(startMedia);
  const goal = pickMediaTitle(goalMedia);
  const pathLine =
    pathHistory.length > 1 ? `\n${formatPathSummary(pathHistory)}` : '';
  const urlLine = pageUrl ? `\n${pageUrl}` : '';
  return `Anime to Anime: ${start} → ${goal} in ${animeHops} anime hop${animeHops === 1 ? '' : 's'}${pathLine}${urlLine}`;
}

export function WinScreen({
  startMedia,
  goalMedia,
  animeHops,
  pathHistory,
  onPlayAgain,
}: Props) {
  const onCopySummary = () => {
    const summaryText = buildSummaryCopyText(
      startMedia,
      goalMedia,
      animeHops,
      pathHistory,
      currentPageUrl(),
    );
    void navigator.clipboard.writeText(summaryText);
  };

  return (
    <section className="page-section anime-to-anime-win">
      <h2 className="anime-to-anime-win-title">Goal reached!</h2>
      <p className="anime-to-anime-win-route">
        <strong>{pickMediaTitle(startMedia)}</strong>
        <span aria-hidden="true"> → </span>
        <strong>{pickMediaTitle(goalMedia)}</strong>
      </p>
      <p className="anime-to-anime-win-hops">
        Anime hops: <strong>{animeHops}</strong>
      </p>
      {pathHistory.length > 1 && (
        <p className="anime-to-anime-win-path">{formatPathSummary(pathHistory)}</p>
      )}
      <div className="anime-to-anime-actions anime-to-anime-win-actions">
        <button type="button" className="btn primary" onClick={onCopySummary}>
          Copy summary
        </button>
        <button type="button" className="btn" onClick={onPlayAgain}>
          Play again
        </button>
      </div>
    </section>
  );
}
