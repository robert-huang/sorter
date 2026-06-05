import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudMenuStatus } from '../components/SettingsMenu';
import {
  type AuthState as CloudAuthState,
  getAuthState as cloudGetAuthState,
  handleAuthRedirect as cloudHandleAuthRedirect,
  pickFolder as cloudPickFolder,
  signIn as cloudSignIn,
  signOut as cloudSignOut,
  subscribeAuthChange as cloudSubscribeAuthChange,
} from '../lib/cloud';
import { dbSyncErrorMessage } from '../lib/db/dbSyncErrorMessage';
import { pullDbFromDrive, pushDbToDrive } from '../lib/db/sync';
import { recordSourceDbDirtyWrite } from '../lib/db/syncManifest';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';
import { configureAnilistRunnerHooks } from '../lib/importers/anilist/runners';
import { InFlightTracker } from '../lib/inFlightTracker';
import { isAutosaveAvailable } from '../lib/storage';

export interface SourceDbSyncControls {
  autosaveAvailable: boolean;
  cloudStatus: CloudMenuStatus;
  cloudFolderName?: string;
  cloudActionError: string | null;
  onCloudSignIn: () => void;
  onCloudPickFolder: () => void;
  onCloudSignOut: () => void;
  dbPushingIds: ReadonlySet<string>;
  dbPullingIds: ReadonlySet<string>;
  sourceDbErrors: Record<string, string>;
  dbSyncRevision: number;
  /** Ad-hoc local DB write — bumps pending counter and refreshes sync UI. */
  bumpSourceDbDirty: (sourceId: string) => void;
  onDbPushSource: (sourceId: string) => void;
  onDbPullSource: (sourceId: string) => void;
}

/**
 * Cloud auth + per-source DB push/pull controls shared by the main
 * Sorter gear menu and the Anime to Anime settings menu.
 */
export function useSourceDbSync(): SourceDbSyncControls {
  const autosaveAvailable = isAutosaveAvailable();
  const cloudAvailable = autosaveAvailable;

  const [cloudAuth, setCloudAuth] = useState<CloudAuthState>(() =>
    cloudAvailable ? cloudGetAuthState() : { status: 'signed-out' },
  );
  const [cloudActionError, setCloudActionError] = useState<string | null>(null);
  const [dbPushingIds, setDbPushingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dbPullingIds, setDbPullingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sourceDbErrors, setSourceDbErrors] = useState<Record<string, string>>(
    {},
  );
  const [dbSyncRevision, setDbSyncRevision] = useState(0);

  const dbPushTrackerRef = useRef(new InFlightTracker());
  const dbPullTrackerRef = useRef(new InFlightTracker());

  const cloudStatus: CloudMenuStatus = useMemo(() => {
    if (!cloudAvailable) return 'unavailable';
    if (cloudAuth.status === 'signed-out') return 'signed-out';
    if (cloudAuth.status === 'expired') return 'expired';
    if (!cloudAuth.folderId) return 'needs-folder';
    return 'ready';
  }, [cloudAvailable, cloudAuth]);

  const cloudFolderName =
    cloudAuth.status === 'signed-in' ? cloudAuth.folderName : undefined;

  useEffect(() => {
    if (typeof window === 'undefined' || !cloudAvailable) return;
    let canceled = false;
    void (async () => {
      try {
        await cloudHandleAuthRedirect();
      } catch (err) {
        console.warn('cloud auth redirect failed', err);
      }
      if (canceled) return;
      setCloudAuth(cloudGetAuthState());
    })();
    return () => {
      canceled = true;
    };
  }, [cloudAvailable]);

  useEffect(() => {
    if (!cloudAvailable) return;
    const unsub = cloudSubscribeAuthChange((state) => setCloudAuth(state));
    setCloudAuth(cloudGetAuthState());
    return () => {
      unsub();
    };
  }, [cloudAvailable]);

  const bumpSourceDbDirty = useCallback((sourceId: string) => {
    recordSourceDbDirtyWrite(sourceId);
    setDbSyncRevision((r) => r + 1);
  }, []);

  const onDbPushSource = useCallback(
    (sourceId: string) => {
      if (!autosaveAvailable || cloudStatus !== 'ready') return;
      if (!dbPushTrackerRef.current.tryAcquire(sourceId)) return;
      setDbPushingIds(dbPushTrackerRef.current.snapshot());
      setSourceDbErrors((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      void (async () => {
        try {
          await pushDbToDrive(sourceId);
          setDbSyncRevision((r) => r + 1);
        } catch (err) {
          setSourceDbErrors((prev) => ({
            ...prev,
            [sourceId]: dbSyncErrorMessage(err),
          }));
          setDbSyncRevision((r) => r + 1);
        } finally {
          dbPushTrackerRef.current.release(sourceId);
          setDbPushingIds(dbPushTrackerRef.current.snapshot());
        }
      })();
    },
    [autosaveAvailable, cloudStatus],
  );

  const onDbPullSource = useCallback(
    (sourceId: string) => {
      if (!autosaveAvailable || cloudStatus !== 'ready') return;
      if (!dbPullTrackerRef.current.tryAcquire(sourceId)) return;
      setDbPullingIds(dbPullTrackerRef.current.snapshot());
      setSourceDbErrors((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      void (async () => {
        try {
          await pullDbFromDrive(sourceId);
          setDbSyncRevision((r) => r + 1);
        } catch (err) {
          setSourceDbErrors((prev) => ({
            ...prev,
            [sourceId]: dbSyncErrorMessage(err),
          }));
          setDbSyncRevision((r) => r + 1);
        } finally {
          dbPullTrackerRef.current.release(sourceId);
          setDbPullingIds(dbPullTrackerRef.current.snapshot());
        }
      })();
    },
    [autosaveAvailable, cloudStatus],
  );

  useEffect(() => {
    configureAnilistRunnerHooks({
      onAutoPushRequested: () => onDbPushSource(ANILIST_SOURCE_ID),
      onDirtyBumped: () => setDbSyncRevision((r) => r + 1),
    });
    return () => {
      configureAnilistRunnerHooks({});
    };
  }, [onDbPushSource]);

  const onCloudSignIn = useCallback(() => {
    setCloudActionError(null);
    void (async () => {
      try {
        await cloudSignIn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cloud sign-in failed.';
        setCloudActionError(msg);
      }
    })();
  }, []);

  const onCloudPickFolder = useCallback(() => {
    setCloudActionError(null);
    void (async () => {
      try {
        await cloudPickFolder();
      } catch (err) {
        console.debug('folder pick canceled', err);
      }
    })();
  }, []);

  const onCloudSignOut = useCallback(() => {
    setCloudActionError(null);
    void (async () => {
      await cloudSignOut();
    })();
  }, []);

  return {
    autosaveAvailable,
    cloudStatus,
    cloudFolderName,
    cloudActionError,
    onCloudSignIn,
    onCloudPickFolder,
    onCloudSignOut,
    dbPushingIds,
    dbPullingIds,
    sourceDbErrors,
    dbSyncRevision,
    bumpSourceDbDirty,
    onDbPushSource,
    onDbPullSource,
  };
}
