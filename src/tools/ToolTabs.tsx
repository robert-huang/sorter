import { useLayoutEffect, useRef, useState } from 'react';

export interface ToolTab<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  tabs: ReadonlyArray<ToolTab<T>>;
  activeTab: T;
  onTabChange: (id: T) => void;
}

/**
 * Floating tab strip with a sliding accent indicator. The measure/observe
 * logic is lifted from the Sorter `Header.tsx` tab strip, generalized over
 * an arbitrary tab list so the Tools app can reuse the same look.
 */
export function ToolTabs<T extends string>({
  tabs,
  activeTab,
  onTabChange,
}: Props<T>) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  useLayoutEffect(() => {
    function measure(): void {
      const card = cardRef.current;
      const pill = pillRefs.current[activeTab];
      if (!card || !pill) return;
      setIndicator({ left: pill.offsetLeft, width: pill.offsetWidth });
    }
    measure();
    const card = cardRef.current;
    if (!card) return;

    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(card);
    for (const t of tabs) {
      const pill = pillRefs.current[t.id];
      if (pill) {
        ro?.observe(pill);
      }
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeTab, tabs]);

  return (
    <div className="tabs-card-wrap tools-tabs-wrap">
      <div className="tabs-card tools-tabs-card" role="tablist" ref={cardRef}>
        <div
          className="tab-indicator"
          style={{
            transform: `translateX(${indicator.left}px)`,
            width: indicator.width,
          }}
        />
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              pillRefs.current[t.id] = el;
            }}
            role="tab"
            aria-selected={activeTab === t.id}
            className={`tab-pill ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
