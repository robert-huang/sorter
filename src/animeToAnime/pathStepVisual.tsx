import {
  anilistUrlForPathStep,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';
import type { PathStep } from './pathHistory';
import { pathStepLabel } from './pathHistory';

export function PathStepBubble({
  step,
  isCurrent = false,
  compact = false,
  onOpenStep,
}: {
  step: PathStep;
  isCurrent?: boolean;
  compact?: boolean;
  /**
   * When set, left-clicking (or Enter/Space) the bubble opens the detail
   * modal for this step. Only wired from the result screen so the
   * in-game trail stays non-interactive. Middle-click still opens AniList
   * regardless.
   */
  onOpenStep?: (step: PathStep) => void;
}) {
  const imageSrc = step.kind === 'anime' ? step.coverImage : step.image;
  const label = pathStepLabel(step);
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  const anilistLink = bindAnilistMiddleClick(anilistUrlForPathStep(step));
  const interactive = Boolean(onOpenStep);
  const className = mergeAnilistLinkClass(
    [
      'anime-to-anime-path-step',
      compact ? 'anime-to-anime-path-step--compact' : '',
      isCurrent ? 'anime-to-anime-path-step--current' : '',
      interactive ? 'anime-to-anime-path-step--interactive' : '',
    ]
      .filter(Boolean)
      .join(' '),
    anilistLink.className,
  );

  const title = interactive
    ? `${label} — click for details${
        anilistLink.title ? ' · middle-click opens AniList' : ''
      }`
    : anilistLink.title ?? label;

  return (
    <div
      className={className}
      title={title}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Open details for ${label}` : undefined}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
      onClick={interactive ? () => onOpenStep?.(step) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenStep?.(step);
              }
            }
          : undefined
      }
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" className="anime-to-anime-path-step-img" />
      ) : (
        <span className="anime-to-anime-path-step-initial" aria-hidden="true">
          {initial}
        </span>
      )}
    </div>
  );
}

export function PathTrailEdge({
  kind,
  compact = false,
  viaLabel,
}: {
  kind: 'anime' | 'staff';
  compact?: boolean;
  viaLabel?: string;
}) {
  return (
    <span
      className={[
        'anime-to-anime-path-edge',
        `anime-to-anime-path-edge--${kind}`,
        compact ? 'anime-to-anime-path-edge--compact' : '',
        viaLabel ? 'anime-to-anime-path-edge--labeled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={viaLabel}
      aria-hidden={viaLabel ? undefined : true}
    >
      →
    </span>
  );
}
