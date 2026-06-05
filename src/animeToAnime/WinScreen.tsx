import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { currentPageUrl } from '../lib/appRoutes';
import { formatPathSummary, type PathStep } from './pathHistory';
import { WinPathTrail } from './WinPathTrail';

interface Props {
  startMedia: MediaRow;
  goalMedia: MediaRow;
  linksUsed: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
}

function buildSummaryCopyText(
  startMedia: MediaRow,
  goalMedia: MediaRow,
  linksUsed: number,
  pathHistory: readonly PathStep[],
  pageUrl: string,
): string {
  const start = pickMediaTitle(startMedia);
  const goal = pickMediaTitle(goalMedia);
  const pathLine =
    pathHistory.length > 1 ? `\n${formatPathSummary(pathHistory)}` : '';
  const urlLine = pageUrl ? `\n${pageUrl}` : '';
  return `Anime to Anime: ${start} → ${goal} in ${linksUsed} link${linksUsed === 1 ? '' : 's'} used${pathLine}${urlLine}`;
}

export function WinScreen({
  startMedia,
  goalMedia,
  linksUsed,
  pathHistory,
  onPlayAgain,
}: Props) {
  const onCopySummary = () => {
    const summaryText = buildSummaryCopyText(
      startMedia,
      goalMedia,
      linksUsed,
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
        Links used: <strong>{linksUsed}</strong>
      </p>
      {pathHistory.length > 1 && <WinPathTrail steps={pathHistory} />}
      <div className="anime-to-anime-actions anime-to-anime-win-actions">
        <button type="button" className="btn primary" onClick={onCopySummary}>
          Share Results
        </button>
        <button type="button" className="btn" onClick={onPlayAgain}>
          Play Again
        </button>
      </div>
    </section>
  );
}
