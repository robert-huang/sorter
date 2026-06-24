import { useEffect, useState } from 'react';
import { openSourceDb } from '../lib/db/client';
import {
  DB_NON_PERSISTENT_EVENT,
  type DbNonPersistentEventDetail,
  type DbNonPersistentReason,
} from '../lib/db/opfs';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';

/**
 * Detect when this tab fell back to in-memory SQLite (OPFS lock held elsewhere
 * or OPFS unavailable). Kicks `openSourceDb` on mount so the worker boots even
 * when the page does not otherwise touch the DB.
 */
export function useDbNonPersistentBanner() {
  const [active, setActive] = useState(false);
  const [reason, setReason] = useState<DbNonPersistentReason>('opfs_unavailable');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (event: Event): void => {
      setActive(true);
      const detail = (event as CustomEvent<DbNonPersistentEventDetail>).detail?.reason;
      if (detail) {
        setReason(detail);
      }
    };
    window.addEventListener(DB_NON_PERSISTENT_EVENT, handler);
    void openSourceDb(ANILIST_SOURCE_ID)
      .then((result) => {
        if (result.storageMode !== 'memory') {
          return;
        }
        setActive(true);
        setReason(
          result.opfsLockContendedByOtherTab ? 'other_tab' : 'opfs_unavailable',
        );
      })
      .catch(() => {});
    return () => {
      window.removeEventListener(DB_NON_PERSISTENT_EVENT, handler);
    };
  }, []);

  return {
    show: active && !dismissed,
    reason,
    dismiss: () => setDismissed(true),
  };
}
