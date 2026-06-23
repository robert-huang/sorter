import { useLayoutEffect } from 'react';

/**
 * Keeps `--tools-season-sticky-top` in sync with the actual sticky chrome
 * (header + optional wait banner + tab strip) so season column headers pin
 * flush below the floating tabs while scrolling.
 */
export function useToolsChromeStickyTop(): void {
  useLayoutEffect(() => {
    const rootNode = document.querySelector('.tools-app');
    if (!(rootNode instanceof HTMLElement)) {
      return;
    }
    const appRoot: HTMLElement = rootNode;

    function measure(): void {
      const header = appRoot.querySelector('.anime-to-anime-header');
      const banner = appRoot.querySelector('.app-banner-stack');
      const tabs = appRoot.querySelector('.tools-tabs-wrap');
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
      appRoot.style.setProperty('--tools-header-height', `${headerHeight}px`);
      appRoot.style.setProperty('--tools-tabs-sticky-top', `${tabsTop}px`);
      appRoot.style.setProperty('--tools-season-sticky-top', `${seasonStickyTop}px`);
    }

    measure();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const header = appRoot.querySelector('.anime-to-anime-header');
    const banner = appRoot.querySelector('.app-banner-stack');
    const tabs = appRoot.querySelector('.tools-tabs-wrap');
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
