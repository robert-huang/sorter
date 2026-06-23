import { useLayoutEffect } from 'react';

/**
 * Keeps `--tools-season-sticky-top` in sync with the actual sticky chrome
 * (header + optional wait banner + tab strip) so season column headers pin
 * flush below the floating tabs while scrolling.
 */
export function useToolsChromeStickyTop(): void {
  useLayoutEffect(() => {
    const root = document.querySelector('.tools-app');
    if (!root) {
      return;
    }

    function measure(): void {
      const header = root!.querySelector('.anime-to-anime-header');
      const banner = root!.querySelector('.tools-wait-banner');
      const tabs = root!.querySelector('.tools-tabs-wrap');
      let headerHeight = 0;
      let tabsTop = 0;
      let seasonStickyTop = 0;
      if (header instanceof HTMLElement) {
        headerHeight = header.offsetHeight;
        tabsTop += headerHeight;
        seasonStickyTop += headerHeight;
      }
      if (banner instanceof HTMLElement) {
        tabsTop += banner.offsetHeight;
        seasonStickyTop += banner.offsetHeight;
      }
      if (tabs instanceof HTMLElement) {
        seasonStickyTop += tabs.offsetHeight;
      }
      root!.style.setProperty('--tools-header-height', `${headerHeight}px`);
      root!.style.setProperty('--tools-tabs-sticky-top', `${tabsTop}px`);
      root!.style.setProperty('--tools-season-sticky-top', `${seasonStickyTop}px`);
    }

    measure();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const header = root.querySelector('.anime-to-anime-header');
    const banner = root.querySelector('.tools-wait-banner');
    const tabs = root.querySelector('.tools-tabs-wrap');
    for (const el of [header, banner, tabs]) {
      if (el && ro) {
        ro.observe(el);
      }
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
}
