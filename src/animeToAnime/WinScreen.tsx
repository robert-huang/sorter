import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { currentPageUrl } from '../lib/appRoutes';
import type {
  BuildCachedRouteStream,
  CachedRouteStream,
  CollapsedRoute,
} from './cachedGraph';
import { formatPathSummary, type PathStep } from './pathHistory';
import { WinPathTrail } from './WinPathTrail';
import { CollapsedRouteTrail } from './CollapsedRouteTrail';

export type RoundEndOutcome = 'won' | 'gave_up';

interface Props {
  outcome: RoundEndOutcome;
  startMedia: MediaRow;
  goalMedia: MediaRow;
  linksUsed: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
  /** Build a stream that lazily yields every shortest cached route. */
  onBuildCachedPathStream?: () => Promise<BuildCachedRouteStream>;
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
      /** Distinct shortest routes shown so far, appended one per click. */
      routes: CollapsedRoute[];
      /** True once the enumerator has yielded every shortest route. */
      exhausted: boolean;
      /** True while the next route is being pulled/hydrated. */
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
  // Holds the live enumerator across "Find another route" clicks so the
  // adjacency/BFS work happens once, not on every click.
  const streamRef = useRef<CachedRouteStream | null>(null);
  // Tracks how many routes were shown on the previous render so the effect
  // only scrolls on a genuine append, not the initial reveal (0 → 1).
  const shownRouteCountRef = useRef(0);
  // Mirror of the latest UI state so the rebuild-on-filter-change effect can
  // read the current phase without re-running on every cachedPath change.
  const cachedPathRef = useRef(cachedPath);
  cachedPathRef.current = cachedPath;
  // Skips the first effect run (initial mount) so we only rebuild when the
  // build callback identity actually changes (i.e. the gender filter changed).
  const skipFirstRebuildRef = useRef(true);

  const shownRouteCount =
    cachedPath.phase === 'shown' ? cachedPath.routes.length : 0;

  useEffect(() => {
    const prevCount = shownRouteCountRef.current;
    shownRouteCountRef.current = shownRouteCount;
    // Only auto-scroll when "Find another route" added a route on top of an
    // already-revealed one; skip the first reveal and any reset to 0.
    if (shownRouteCount > prevCount && prevCount >= 1) {
      // Scroll the whole page all the way to its bottom (not just the button
      // into the viewport edge) so it stays pinned under the cursor for
      // repeated clicks even as appended paths grow the page.
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    }
  }, [shownRouteCount]);

  // When the gender filter changes mid-results the build callback identity
  // changes and the existing stream is stale. Keep the already-shown routes on
  // screen, but swap in a freshly-built stream so the next "Find another route"
  // returns routes matching the new filter. If a prior search was a miss, reset
  // to the "Shortest path (cached)" button so it can be retried under the new
  // filter.
  useEffect(() => {
    if (skipFirstRebuildRef.current) {
      skipFirstRebuildRef.current = false;
      return;
    }
    if (!onBuildCachedPathStream) {
      return;
    }
    const state = cachedPathRef.current;
    if (state.phase === 'not_found') {
      streamRef.current = null;
      setCachedPath({ phase: 'idle' });
      return;
    }
    if (state.phase !== 'shown') {
      return;
    }
    let cancelled = false;
    void onBuildCachedPathStream()
      .then((built) => {
        if (cancelled) {
          return;
        }
        if (built.status !== 'ready') {
          streamRef.current = null;
          setCachedPath((prev) =>
            prev.phase === 'shown' ? { ...prev, exhausted: true, loadingMore: false } : prev,
          );
          return;
        }
        streamRef.current = built.stream;
        setCachedPath((prev) =>
          prev.phase === 'shown' ? { ...prev, exhausted: false, loadingMore: false } : prev,
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        streamRef.current = null;
        setCachedPath((prev) =>
          prev.phase === 'shown' ? { ...prev, exhausted: true, loadingMore: false } : prev,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [onBuildCachedPathStream]);

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
            routes: [first.route],
            exhausted: false,
            loadingMore: false,
          });
          return;
        }
        // "ready" implies at least one route; treat an empty stream as a miss.
        streamRef.current = null;
        setCachedPath({ phase: 'not_found' });
      })
      .catch(() => {
        streamRef.current = null;
        setCachedPath({ phase: 'not_found' });
      });
  }, [onBuildCachedPathStream]);

  const onFindAnotherRoute = useCallback(() => {
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
              routes: [...prev.routes, result.route],
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
          {cachedPath.routes.map((route, index) => (
            <div
              key={`cached-route-${index}`}
              className="anime-to-anime-win-cached-path"
            >
              {cachedPath.routes.length > 1 && (
                <p className="anime-to-anime-win-cached-path-label">
                  Route {index + 1}
                </p>
              )}
              {route.items.length > 1 && (
                <CollapsedRouteTrail route={route} onOpenStep={onOpenStep} />
              )}
            </div>
          ))}
          {cachedPath.exhausted ? (
            <p className="anime-to-anime-win-cached-hint">
              That's every shortest route in your cache ({cachedPath.routes.length}).
            </p>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={cachedPath.loadingMore}
              onClick={onFindAnotherRoute}
            >
              {cachedPath.loadingMore ? 'Searching…' : 'Find another route'}
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
