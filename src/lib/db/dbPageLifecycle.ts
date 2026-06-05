import { resetDbTransport, shutdownDbTransport } from './client';

/** Tear down the DB worker on navigation so the next page can acquire OPFS. */
export function installDbPageLifecycle(): void {
  window.addEventListener('pagehide', () => {
    shutdownDbTransport();
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (event.persisted) {
      resetDbTransport();
    }
  });
}
