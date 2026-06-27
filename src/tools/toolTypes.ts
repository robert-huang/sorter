/** Shared types for the Tools app shell + its tool panels. */

export type ToolId =
  | 'shared-credits'
  | 'shared-staff'
  | 'seasonal-scores'
  | 'franchise-scores'
  | 'favourites'
  | 'update-list-entry';

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
}

export const TOOLS_ACTIVE_TOOL_KEY = 'anime-tools-active-tool';

const TOOL_IDS: readonly ToolId[] = [
  'shared-credits',
  'shared-staff',
  'seasonal-scores',
  'franchise-scores',
  'favourites',
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
