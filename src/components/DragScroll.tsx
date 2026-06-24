import type { ReactNode } from 'react';
import { useDragScroll } from '../lib/hooks/useDragScroll';

type DragScrollProps = {
  className?: string;
  children: ReactNode;
};

/** Scroll container that supports click-drag panning in any scroll direction. */
export function DragScroll({ className, children }: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={['tool-drag-scroll', className].filter(Boolean).join(' ')}
      {...dragProps}
    >
      {children}
    </div>
  );
}
