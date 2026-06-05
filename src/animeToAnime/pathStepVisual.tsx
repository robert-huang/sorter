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
}: {
  step: PathStep;
  isCurrent?: boolean;
  compact?: boolean;
}) {
  const imageSrc = step.kind === 'anime' ? step.coverImage : step.image;
  const label = pathStepLabel(step);
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  const anilistLink = bindAnilistMiddleClick(anilistUrlForPathStep(step));
  const className = mergeAnilistLinkClass(
    [
      'anime-to-anime-path-step',
      compact ? 'anime-to-anime-path-step--compact' : '',
      isCurrent ? 'anime-to-anime-path-step--current' : '',
    ]
      .filter(Boolean)
      .join(' '),
    anilistLink.className,
  );

  return (
    <div
      className={className}
      title={anilistLink.title ?? label}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
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
}: {
  kind: 'anime' | 'staff';
  compact?: boolean;
}) {
  return (
    <span
      className={[
        'anime-to-anime-path-edge',
        `anime-to-anime-path-edge--${kind}`,
        compact ? 'anime-to-anime-path-edge--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    >
      →
    </span>
  );
}
