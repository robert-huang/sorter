import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnilistDetailModal } from '../components/AnilistDetailModal';
import { StaffDetailModal } from '../components/StaffDetailModal';
import { useSourceDbSync } from '../hooks/useSourceDbSync';
import { readSettings, updateSettings } from '../lib/storage';
import {
  applyAnimeToAnimeTheme,
  loadAnimeToAnimeTheme,
  saveAnimeToAnimeTheme,
  type AnimeToAnimeTheme,
} from '../animeToAnime/theme';
import { ToolsHeader } from './ToolsHeader';
import { ToolTabs, type ToolTab } from './ToolTabs';
import { configureToolsImportDirtyHook } from '../lib/importers/anilist/toolsImportContext';
import { useAnilistApiWait } from './useAnilistApiWait';
import {
  loadActiveTool,
  saveActiveTool,
  type ToolId,
  type ToolPanelProps,
} from './toolTypes';
import { SharedCreditsPanel } from './panels/SharedCreditsPanel';
import { SharedStaffPanel } from './panels/SharedStaffPanel';
import { SeasonalScoresPanel } from './panels/SeasonalScoresPanel';
import { FavouritesPanel } from './panels/FavouritesPanel';

const TOOL_TABS: ReadonlyArray<ToolTab<ToolId>> = [
  { id: 'shared-credits', label: 'Shared Credits' },
  { id: 'shared-staff', label: 'Shared Staff' },
  { id: 'seasonal-scores', label: 'Seasonal Scores' },
  { id: 'favourites', label: 'Favourites' },
];

interface MediaTarget {
  mediaId: number;
  fallbackTitle: string;
  forceRefresh?: boolean;
}

interface StaffTarget {
  staffId: number;
  fallbackName: string;
}

export function ToolsApp() {
  const dbSync = useSourceDbSync();
  const [theme, setTheme] = useState<AnimeToAnimeTheme>(() =>
    loadAnimeToAnimeTheme(),
  );
  const [historyBackGuard, setHistoryBackGuard] = useState(
    () => !!readSettings().historyBackGuard,
  );
  const [activeTool, setActiveTool] = useState<ToolId>(() => loadActiveTool());
  const [mediaTarget, setMediaTarget] = useState<MediaTarget | null>(null);
  const [staffTarget, setStaffTarget] = useState<StaffTarget | null>(null);

  const onToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: AnimeToAnimeTheme = prev === 'dark' ? 'light' : 'dark';
      applyAnimeToAnimeTheme(next);
      saveAnimeToAnimeTheme(next);
      return next;
    });
  }, []);

  const onTabChange = useCallback((id: ToolId) => {
    setActiveTool(id);
    saveActiveTool(id);
  }, []);

  const onOpenMedia = useCallback(
    (mediaId: number, fallbackTitle: string, options?: { forceRefresh?: boolean }) => {
      setMediaTarget({
        mediaId,
        fallbackTitle,
        forceRefresh: options?.forceRefresh,
      });
    },
    [],
  );

  const onOpenStaff = useCallback((staffId: number, fallbackName: string) => {
    setStaffTarget({ staffId, fallbackName });
  }, []);

  const onToggleHistoryBackGuard = useCallback(() => {
    setHistoryBackGuard((prev) => {
      const next = !prev;
      updateSettings({ historyBackGuard: next });
      return next;
    });
  }, []);

  const panelProps: ToolPanelProps = useMemo(
    () => ({ onOpenMedia, onOpenStaff }),
    [onOpenMedia, onOpenStaff],
  );

  useEffect(() => {
    configureToolsImportDirtyHook({
      onDirtyBumped: () => dbSync.refreshDbSyncRevision(),
    });
    return () => {
      configureToolsImportDirtyHook({});
    };
  }, [dbSync.refreshDbSyncRevision]);

  const { apiWait, apiWaitSecondsLeft } = useAnilistApiWait();

  const apiWaitBanner =
    apiWait &&
    apiWaitSecondsLeft !== null && (
      <div className="tools-wait-banner app-banner warn">
        <span>
          AniList rate limit — retrying in {apiWaitSecondsLeft}s (attempt {apiWait.attempt})
        </span>
      </div>
    );

  return (
    <div className="anime-to-anime-app tools-app">
      <ToolsHeader
        theme={theme}
        onToggleTheme={onToggleTheme}
        historyBackGuard={historyBackGuard}
        onToggleHistoryBackGuard={onToggleHistoryBackGuard}
        dbSync={dbSync}
      />
      {apiWaitBanner}
      <ToolTabs tabs={TOOL_TABS} activeTab={activeTool} onTabChange={onTabChange} />

      <main className="tools-main">
        {/* Each panel keeps its own state mounted while hidden so a tab
            switch doesn't discard in-progress results. */}
        <div hidden={activeTool !== 'shared-credits'}>
          <SharedCreditsPanel {...panelProps} />
        </div>
        <div hidden={activeTool !== 'shared-staff'}>
          <SharedStaffPanel {...panelProps} />
        </div>
        <div hidden={activeTool !== 'seasonal-scores'}>
          <SeasonalScoresPanel {...panelProps} />
        </div>
        <div hidden={activeTool !== 'favourites'}>
          <FavouritesPanel {...panelProps} />
        </div>
      </main>

      {mediaTarget && (
        <AnilistDetailModal
          mediaId={mediaTarget.mediaId}
          fallbackTitle={mediaTarget.fallbackTitle}
          initialForceRefresh={mediaTarget.forceRefresh}
          onClose={() => setMediaTarget(null)}
          onOpenStaff={onOpenStaff}
        />
      )}
      {staffTarget && (
        <StaffDetailModal
          staffId={staffTarget.staffId}
          fallbackName={staffTarget.fallbackName}
          onClose={() => setStaffTarget(null)}
          onOpenMedia={onOpenMedia}
        />
      )}
    </div>
  );
}
