import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { currentPageUrl } from '../lib/appRoutes';
import type {
  BuildCachedShortestPathStream,
  CachedShortestPathStream,
} from './cachedGraph';
import { formatPathSummary, type PathStep } from './pathHistory';
import { WinPathTrail } from './WinPathTrail';

export type RoundEndOutcome = 'won' | 'gave_up';

interface Props {
  outcome: RoundEndOutcome;
  startMedia: MediaRow;
  goalMedia: MediaRow;
  linksUsed: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
  /** Build a stream that lazily yields every shortest cached path. */
  onBuildCachedPathStream?: () => Promise<BuildCachedShortestPathStream>;
  /** Open the detail modal for a path node (result-screen only). */
  onOpenStep?: (step: PathStep) => void;
  /** Open the media detail modal for the start/goal tiles. */
  onOpenMedia?: (mediaId: number, fallbackTitle: string) => void;
}

/**
 * Start/goal title in the result header. Renders as a button that opens
 * the media detail modal when an opener is wired, otherwise as plain
 * bold text (keeps the in-game / no-opener rendering unchanged).
 */
function RouteTitle({
  media,
  onOpenMedia,
}: {
  media: MediaRow;
  onOpenMedia?: (mediaId: number, fallbackTitle: string) => void;
}) {
  const title = pickMediaTitle(media);
  if (!onOpenMedia) {
    return <strong>{title}</strong>;
  }
  return (
    <button
      type="button"
      className="anime-to-anime-win-route-link"
      onClick={() => onOpenMedia(media.id, title)}
    >
      {title}
    </button>
  );
}

type CachedPathUiState =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | {
      phase: 'shown';
      optimalLinks: number;
      /** Distinct shortest paths shown so far, appended one per click. */
      paths: PathStep[][];
      /** True once the enumerator has yielded every shortest path. */
      exhausted: boolean;
      /** True while the next path is being pulled/hydrated. */
      loadingMore: boolean;
    }
  | { phase: 'not_found' };

function buildSummaryCopyText(
  outcome: RoundEndOutcome,
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
  const headline =
    outcome === 'won'
      ? `Anime to Anime: ${start} → ${goal} in ${linksUsed} link${linksUsed === 1 ? '' : 's'} used`
      : `Anime to Anime (gave up): ${start} → ${goal} after ${linksUsed} link${linksUsed === 1 ? '' : 's'}`;
  return `${headline}${pathLine}${urlLine}`;
}

function cachedPathNotFoundMessage(outcome: RoundEndOutcome): string {
  if (outcome === 'gave_up') {
    return 'No path found in your local cache — expand more shows/staff or try different round rules.';
  }
  return 'Could not look up a shorter path in your cache — yours may already be optimal among known edges.';
}

export function WinScreen({
  outcome,
  startMedia,
  goalMedia,
  linksUsed,
  pathHistory,
  onPlayAgain,
  onBuildCachedPathStream,
  onOpenStep,
  onOpenMedia,
}: Props) {
  const [cachedPath, setCachedPath] = useState<CachedPathUiState>({ phase: 'idle' });
  const [summaryCopied, setSummaryCopied] = useState(false);
  // Holds the live enumerator across "Find another path" clicks so the
  // adjacency/BFS work happens once, not on every click.
  const streamRef = useRef<CachedShortestPathStream | null>(null);
  // Tracks how many paths were shown on the previous render so the effect
  // only scrolls on a genuine append, not the initial reveal (0 → 1).
  const shownPathCountRef = useRef(0);

  const shownPathCount =
    cachedPath.phase === 'shown' ? cachedPath.paths.length : 0;

  useEffect(() => {
    const prevCount = shownPathCountRef.current;
    shownPathCountRef.current = shownPathCount;
    // Only auto-scroll when "Find another path" added a path on top of an
    // already-revealed one; skip the first reveal and any reset to 0.
    if (shownPathCount > prevCount && prevCount >= 1) {
      // Scroll the whole page all the way to its bottom (not just the button
      // into the viewport edge) so it stays pinned under the cursor for
      // repeated clicks even as appended paths grow the page.
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    }
  }, [shownPathCount]);

  const onCopySummary = async () => {
    const summaryText = buildSummaryCopyText(
      outcome,
      startMedia,
      goalMedia,
      linksUsed,
      pathHistory,
      currentPageUrl(),
    );
    try {
      await navigator.clipboard.writeText(summaryText);
      setSummaryCopied(true);
      setTimeout(() => setSummaryCopied(false), 1500);
    } catch {
      setSummaryCopied(false);
    }
  };

  const onSearchCachedPath = useCallback(() => {
    if (!onBuildCachedPathStream) {
      return;
    }
    setCachedPath({ phase: 'searching' });
    void onBuildCachedPathStream()
      .then(async (built) => {
        if (built.status !== 'ready') {
          streamRef.current = null;
          setCachedPath({ phase: 'not_found' });
          return;
        }
        streamRef.current = built.stream;
        const first = await built.stream.next();
        if (first.status === 'found') {
          setCachedPath({
            phase: 'shown',
            optimalLinks: built.stream.optimalLinks,
            paths: [first.steps],
            exhausted: false,
            loadingMore: false,
          });
          return;
        }
        // "ready" implies at least one path; treat an empty stream as a miss.
        streamRef.current = null;
        setCachedPath({ phase: 'not_found' });
      })
      .catch(() => {
        streamRef.current = null;
        setCachedPath({ phase: 'not_found' });
      });
  }, [onBuildCachedPathStream]);

  const onFindAnotherPath = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) {
      return;
    }
    setCachedPath((prev) =>
      prev.phase === 'shown' ? { ...prev, loadingMore: true } : prev,
    );
    void stream
      .next()
      .then((result) => {
        setCachedPath((prev) => {
          if (prev.phase !== 'shown') {
            return prev;
          }
          if (result.status === 'found') {
            return {
              ...prev,
              paths: [...prev.paths, result.steps],
              loadingMore: false,
            };
          }
          return { ...prev, exhausted: true, loadingMore: false };
        });
      })
      .catch(() => {
        setCachedPath((prev) =>
          prev.phase === 'shown'
            ? { ...prev, exhausted: true, loadingMore: false }
            : prev,
        );
      });
  }, []);

  const showInitialCachedButton =
    Boolean(onBuildCachedPathStream) &&
    (cachedPath.phase === 'idle' || cachedPath.phase === 'searching');

  const title = outcome === 'won' ? 'Goal reached!' : 'Round ended';
  const linksLabel = outcome === 'won' ? 'Links used' : 'Links used before giving up';

  return (
    <section className="page-section anime-to-anime-win">
      <h2 className="anime-to-anime-win-title">{title}</h2>
      <p className="anime-to-anime-win-route">
        <RouteTitle media={startMedia} onOpenMedia={onOpenMedia} />
        <span aria-hidden="true"> → </span>
        <RouteTitle media={goalMedia} onOpenMedia={onOpenMedia} />
      </p>
      <p className="anime-to-anime-win-hops">
        {linksLabel}: <strong>{linksUsed}</strong>
      </p>
      {pathHistory.length > 1 && (
        <WinPathTrail steps={pathHistory} onOpenStep={onOpenStep} />
      )}
      <div className="anime-to-anime-actions anime-to-anime-win-actions">
        {showInitialCachedButton && (
          <button
            type="button"
            className="btn"
            disabled={cachedPath.phase === 'searching'}
            onClick={onSearchCachedPath}
          >
            {cachedPath.phase === 'searching' ? 'Searching…' : 'Shortest path (cached)'}
          </button>
        )}
        <button type="button" className="btn primary" onClick={() => void onCopySummary()}>
          {summaryCopied ? '✓ Copied' : outcome === 'won' ? 'Share Results' : 'Copy summary'}
        </button>
        <button type="button" className="btn" onClick={onPlayAgain}>
          Play Again
        </button>
      </div>
      {cachedPath.phase === 'shown' && (
        <div className="anime-to-anime-win-cached">
          <p className="anime-to-anime-win-cached-summary">
            {outcome === 'won' ? (
              <>
                Shortest in cache: <strong>{cachedPath.optimalLinks}</strong> link
                {cachedPath.optimalLinks === 1 ? '' : 's'}
                {' · '}
                Your path: <strong>{linksUsed}</strong> link{linksUsed === 1 ? '' : 's'}
              </>
            ) : (
              <>
                Shortest in cache: <strong>{cachedPath.optimalLinks}</strong> link
                {cachedPath.optimalLinks === 1 ? '' : 's'}
                {linksUsed > 0 && (
                  <>
                    {' · '}
                    You had used: <strong>{linksUsed}</strong> link
                    {linksUsed === 1 ? '' : 's'}
                  </>
                )}
              </>
            )}
          </p>
          {cachedPath.paths.map((steps, index) => (
            <div
              key={`cached-path-${index}`}
              className="anime-to-anime-win-cached-path"
            >
              {cachedPath.paths.length > 1 && (
                <p className="anime-to-anime-win-cached-path-label">
                  Path {index + 1}
                </p>
              )}
              {steps.length > 1 && (
                <WinPathTrail steps={steps} onOpenStep={onOpenStep} />
              )}
            </div>
          ))}
          {cachedPath.exhausted ? (
            <p className="anime-to-anime-win-cached-hint">
              That's every shortest path in your cache ({cachedPath.paths.length}).
            </p>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={cachedPath.loadingMore}
              onClick={onFindAnotherPath}
            >
              {cachedPath.loadingMore ? 'Searching…' : 'Find another path'}
            </button>
          )}
        </div>
      )}
      {cachedPath.phase === 'not_found' && (
        <p className="anime-to-anime-win-cached-hint">
          {cachedPathNotFoundMessage(outcome)}
        </p>
      )}
    </section>
  );
}
