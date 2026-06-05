import { useLayoutEffect, useRef, type ReactNode } from 'react';

const BANNER_HEIGHT_VAR = '--app-banner-height';

interface Props {
  children: ReactNode;
}

/** Measures stacked `.app-banner` rows and offsets fixed chrome (nav FAB). */
export function AppBannerStack({ children }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const syncHeight = () => {
      const height = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty(BANNER_HEIGHT_VAR, `${height}px`);
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty(BANNER_HEIGHT_VAR, '0px');
    };
  }, [children]);

  return (
    <div ref={ref} className="app-banner-stack">
      {children}
    </div>
  );
}
