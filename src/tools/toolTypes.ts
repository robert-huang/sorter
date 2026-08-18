/** Shared types for the Tools app shell + its tool panels. */

export type ToolId =
  | 'shared-credits'
  | 'shared-staff'
  | 'seasonal-scores'
  | 'weekly-calendar'
  | 'franchise-scores'
  | 'adaptation-scores'
  | 'favourites'
  | 'reorder-favourites'
  | 'bump-chart'
  | 'update-list-entry'
  | 'stats';

import type { ToolsMediaRelationsResponse } from '../lib/importers/anilist/toolsMediaRelationsApi';
import type { SourceDbSyncChange } from '../hooks/useSourceDbSync';

/** Props every tool panel receives so result rows can open the detail modals. */
export interface ToolPanelProps {
  /** Open the media detail modal for a clicked show/title. */
  onOpenMedia: (
    mediaId: number,
    fallbackTitle: string,
    options?: { forceRefresh?: boolean },
  ) => void;
  /** Open the staff detail modal for a clicked staff member / VA. */
  onOpenStaff: (staffId: number, fallbackName: string) => void;
  /**
   * Adaptation Scores registers a handler so modal ↻ relations refresh can
   * merge into the in-memory scan without a full re-compare.
   */
  bindMediaRelationsRefreshHandler?: (
    handler: ((mediaId: number, response: ToolsMediaRelationsResponse) => void) | null,
  ) => void;
  /** Bumps whenever the local AniList DB or its sync state changes. */
  dbSyncRevision: number;
  /** Scope of the change associated with `dbSyncRevision`. */
  dbSyncChange?: SourceDbSyncChange;
}

export const TOOLS_ACTIVE_TOOL_KEY = 'anime-tools-active-tool';

const TOOL_IDS: readonly ToolId[] = [
  'shared-credits',
  'shared-staff',
  'seasonal-scores',
  'franchise-scores',
  'adaptation-scores',
  'stats',
  'weekly-calendar',
  'favourites',
  'reorder-favourites',
  'bump-chart',
  'update-list-entry',
];

export function loadActiveTool(): ToolId {
  try {
    const raw = localStorage.getItem(TOOLS_ACTIVE_TOOL_KEY);
    if (raw && (TOOL_IDS as readonly string[]).includes(raw)) {
      return raw as ToolId;
    }
  } catch {
    /* ignore */
  }
  return 'shared-credits';
}

export function saveActiveTool(tool: ToolId): void {
  try {
    localStorage.setItem(TOOLS_ACTIVE_TOOL_KEY, tool);
  } catch {
    /* ignore */
  }
}
