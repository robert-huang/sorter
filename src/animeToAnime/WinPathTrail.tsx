import { pathStepLabel, type PathStep } from './pathHistory';
import { PathStepBubble, PathTrailEdge } from './pathStepVisual';

interface Props {
  steps: readonly PathStep[];
  /** When set, each stop's bubble opens the detail modal for that step. */
  onOpenStep?: (step: PathStep) => void;
}

export function WinPathTrail({ steps, onOpenStep }: Props) {
  return (
    <div className="anime-to-anime-win-path-trail" aria-label="Path taken">
      {steps.flatMap((step, index) => {
        const stepKey =
          step.kind === 'anime'
            ? `anime-${step.mediaId}-${index}`
            : `staff-${step.staffId}-${index}`;
        const label = pathStepLabel(step);

        const stop = (
          <span key={stepKey} className="anime-to-anime-win-path-stop">
            <PathStepBubble step={step} compact onOpenStep={onOpenStep} />
            <span className="anime-to-anime-win-path-label">{label}</span>
          </span>
        );

        if (index === 0) {
          return [stop];
        }

        return [
          <PathTrailEdge
            key={`edge-${stepKey}`}
            kind={step.kind === 'anime' ? 'anime' : 'staff'}
            compact
            viaLabel={step.viaLabel}
          />,
          stop,
        ];
      })}
    </div>
  );
}
