import {
  anilistUrlForCharacter,
  anilistUrlForPathStep,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';
import type { PathHopCharacter, PathStep } from './pathHistory';
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

  const title = interactive ? `${label} — click for details` : label;

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
  viaCharacters,
}: {
  kind: 'anime' | 'staff';
  compact?: boolean;
  viaLabel?: string;
  /** When set (voice hops), middle-clicking the arrow opens each character. */
  viaCharacters?: readonly PathHopCharacter[];
}) {
  const characterUrls = (viaCharacters ?? []).map((character) =>
    anilistUrlForCharacter(character.id),
  );
  const interactive = characterUrls.length > 0;
  const anilistLink = bindAnilistMiddleClick(interactive ? characterUrls : null);
  const baseClass = [
    'anime-to-anime-path-edge',
    `anime-to-anime-path-edge--${kind}`,
    compact ? 'anime-to-anime-path-edge--compact' : '',
    viaLabel ? 'anime-to-anime-path-edge--labeled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title = viaLabel;

  return (
    <span
      className={mergeAnilistLinkClass(baseClass, anilistLink.className)}
      title={title}
      aria-hidden={viaLabel || interactive ? undefined : true}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      →
    </span>
  );
}
