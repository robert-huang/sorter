import { useState } from 'react';
import type { CollapsedRoute } from './cachedGraph';
import { pathStepLabel, type PathHopCharacter, type PathStep } from './pathHistory';
import { PathStepBubble, PathTrailEdge, SlotBubble } from './pathStepVisual';

interface Props {
  route: CollapsedRoute;
  /** When set, each stop's bubble opens the detail modal for that step. */
  onOpenStep?: (step: PathStep) => void;
}

type EdgeVia = { viaLabel?: string; viaCharacters?: readonly PathHopCharacter[] };

/**
 * Renders a collapsed route as a compact trail. Slots show the currently
 * selected show with a `+N` picker; changing a slot's selection re-derives
 * both arrows around it (the incoming `sPrev→show` edge and the outgoing
 * `show→sNext` edge that labels the following staff hop), so the trail always
 * reflects a concrete, valid shortest path.
 */
export function CollapsedRouteTrail({ route, onOpenStep }: Props) {
  const { items } = route;

  // Index → slot ordinal, so per-slot selection state stays a flat array.
  const slotOrdinalByIndex = new Map<number, number>();
  let slotCount = 0;
  items.forEach((item, index) => {
    if (item.kind === 'slot') {
      slotOrdinalByIndex.set(index, slotCount);
      slotCount += 1;
    }
  });
  const [selected, setSelected] = useState<number[]>(() => Array(slotCount).fill(0));

  const selectionFor = (index: number): number => {
    const ordinal = slotOrdinalByIndex.get(index);
    return ordinal === undefined ? 0 : selected[ordinal] ?? 0;
  };

  const stepAt = (index: number): PathStep => {
    const item = items[index];
    return item.kind === 'fixed' ? item.step : item.options[selectionFor(index)].show;
  };

  /** Incoming edge for the node at `index`, accounting for slot selection. */
  const edgeAt = (index: number): EdgeVia => {
    const item = items[index];
    if (item.kind === 'slot') {
      const option = item.options[selectionFor(index)];
      return { viaLabel: option.show.viaLabel, viaCharacters: option.show.viaCharacters };
    }
    const prev = items[index - 1];
    if (prev && prev.kind === 'slot') {
      // The staff after a slot inherits the selected show's outgoing edge.
      return prev.options[selectionFor(index - 1)].nextStaffVia;
    }
    return { viaLabel: item.step.viaLabel, viaCharacters: item.step.viaCharacters };
  };

  const selectSlot = (ordinal: number, optionIndex: number) => {
    setSelected((prev) => {
      const next = [...prev];
      next[ordinal] = optionIndex;
      return next;
    });
  };

  return (
    <div className="anime-to-anime-win-path-trail" aria-label="Route">
      {items.flatMap((item, index) => {
        const step = stepAt(index);
        const key =
          item.kind === 'slot'
            ? `slot-${index}`
            : step.kind === 'anime'
              ? `anime-${step.mediaId}-${index}`
              : `staff-${step.staffId}-${index}`;
        const label = pathStepLabel(step);

        // Slots own their title (so the right-click menu and +N badge cover
        // the text too); fixed stops render the label as a sibling.
        const stop =
          item.kind === 'slot' ? (
            <span key={key} className="anime-to-anime-win-path-stop">
              <SlotBubble
                options={item.options}
                selectedIndex={selectionFor(index)}
                onSelect={(optionIndex) =>
                  selectSlot(slotOrdinalByIndex.get(index) ?? 0, optionIndex)
                }
                label={label}
                compact
                onOpenStep={onOpenStep}
              />
            </span>
          ) : (
            <span key={key} className="anime-to-anime-win-path-stop">
              <PathStepBubble step={step} compact onOpenStep={onOpenStep} />
              <span className="anime-to-anime-win-path-label">{label}</span>
            </span>
          );

        if (index === 0) {
          return [stop];
        }

        const via = edgeAt(index);
        return [
          <PathTrailEdge
            key={`edge-${key}`}
            kind={step.kind === 'anime' ? 'anime' : 'staff'}
            compact
            viaLabel={via.viaLabel}
            viaCharacters={via.viaCharacters}
          />,
          stop,
        ];
      })}
    </div>
  );
}
