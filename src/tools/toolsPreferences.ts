/**
 * Global, persisted preferences for the Anime Tools surface (separate from
 * per-panel forms). Modeled on `displayPreferences.ts` — a tiny in-memory cache
 * with a pub/sub for cross-component reactivity and cross-tab sync via the
 * `storage` event.
 */

export type ToolsPreferences = {
  /**
   * When true, the Shared Staff compare chart lists every production credit
   * (Storyboard, Production Assistant, etc). When false (default), only the
   * core production roles defined in `staffRoleFilter#isKeyProductionRole`
   * are kept — matching the "key roles" default used by A2A.
   */
  productionAllRoles: boolean;
  /** Infer unique Bump Chart lineages from exact labels and title variants. */
  bumpChartBestMatchByTitle: boolean;
  /** Include available item images when exporting Bump Chart PNGs. */
  bumpChartIncludeExportImages: boolean;
  /** Try verified MyAnimeList images when exporting Bump Chart PNGs. */
  bumpChartMalExportImages: boolean;
  /** Show rewatch counts and weight Seasonal Scores averages by total watches. */
  seasonalScoresShowRepeats: boolean;
  /** Place shows in every Seasonal Scores column their airing dates overlap. */
  seasonalScoresSpanAiringSeasons: boolean;
  /** Include a Weekly Calendar column for entries with no known airing day. */
  weeklyCalendarShowUnscheduledColumn: boolean;
  /** Load and display cached theme songs in Weekly Calendar. */
  weeklyCalendarShowThemeSongs: boolean;
};

const STORAGE_KEY = 'anime-tools:preferences:v1';
const LEGACY_SEASONAL_FORM_KEY = 'anime-tools-seasonal-scores-form';
const LEGACY_WEEKLY_CALENDAR_FORM_KEY = 'anime-tools-weekly-calendar-form';

const DEFAULT_PREFS: ToolsPreferences = {
  productionAllRoles: false,
  bumpChartBestMatchByTitle: true,
  bumpChartIncludeExportImages: false,
  bumpChartMalExportImages: false,
  seasonalScoresShowRepeats: false,
  seasonalScoresSpanAiringSeasons: false,
  weeklyCalendarShowUnscheduledColumn: false,
  weeklyCalendarShowThemeSongs: false,
};

let cached: ToolsPreferences | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readLegacyBoolean(storageKey: string, field: string): boolean {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed[field] === true;
  } catch {
    return false;
  }
}

function defaultPreferencesWithLegacyPanelValues(): ToolsPreferences {
  return {
    ...DEFAULT_PREFS,
    seasonalScoresSpanAiringSeasons: readLegacyBoolean(
      LEGACY_SEASONAL_FORM_KEY,
      'spanAiringSeasons',
    ),
    weeklyCalendarShowUnscheduledColumn: readLegacyBoolean(
      LEGACY_WEEKLY_CALENDAR_FORM_KEY,
      'showUnscheduledColumn',
    ),
    weeklyCalendarShowThemeSongs: readLegacyBoolean(
      LEGACY_WEEKLY_CALENDAR_FORM_KEY,
      'showThemeSongs',
    ),
  };
}

function persistMigratedPreferences(prefs: ToolsPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota */
  }
}

// Cross-tab sync: another tab writing the same key fires `storage` here
// (never in the tab that wrote it). Drop the cache so the next read re-parses,
// then notify subscribers. Guarded for non-browser (test/SSR) environments.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    cached = null;
    emitChange();
  });
}

export function loadToolsPreferences(): ToolsPreferences {
  if (cached) {
    return cached;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = defaultPreferencesWithLegacyPanelValues();
      if (
        cached.seasonalScoresSpanAiringSeasons ||
        cached.weeklyCalendarShowUnscheduledColumn ||
        cached.weeklyCalendarShowThemeSongs
      ) {
        persistMigratedPreferences(cached);
      }
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<ToolsPreferences>;
    cached = {
      productionAllRoles: parsed.productionAllRoles === true,
      bumpChartBestMatchByTitle:
        parsed.bumpChartBestMatchByTitle !== false,
      bumpChartIncludeExportImages:
        parsed.bumpChartIncludeExportImages === true,
      bumpChartMalExportImages: parsed.bumpChartMalExportImages === true,
      seasonalScoresShowRepeats:
        parsed.seasonalScoresShowRepeats === true,
      seasonalScoresSpanAiringSeasons:
        typeof parsed.seasonalScoresSpanAiringSeasons === 'boolean'
          ? parsed.seasonalScoresSpanAiringSeasons
          : readLegacyBoolean(
              LEGACY_SEASONAL_FORM_KEY,
              'spanAiringSeasons',
            ),
      weeklyCalendarShowUnscheduledColumn:
        typeof parsed.weeklyCalendarShowUnscheduledColumn === 'boolean'
          ? parsed.weeklyCalendarShowUnscheduledColumn
          : readLegacyBoolean(
              LEGACY_WEEKLY_CALENDAR_FORM_KEY,
              'showUnscheduledColumn',
            ),
      weeklyCalendarShowThemeSongs:
        typeof parsed.weeklyCalendarShowThemeSongs === 'boolean'
          ? parsed.weeklyCalendarShowThemeSongs
          : readLegacyBoolean(
              LEGACY_WEEKLY_CALENDAR_FORM_KEY,
              'showThemeSongs',
            ),
    };
    if (
      typeof parsed.seasonalScoresSpanAiringSeasons !== 'boolean' ||
      typeof parsed.weeklyCalendarShowUnscheduledColumn !== 'boolean' ||
      typeof parsed.weeklyCalendarShowThemeSongs !== 'boolean'
    ) {
      persistMigratedPreferences(cached);
    }
    return cached;
  } catch {
    cached = defaultPreferencesWithLegacyPanelValues();
    return cached;
  }
}

export function saveToolsPreferences(patch: Partial<ToolsPreferences>): ToolsPreferences {
  const next = { ...loadToolsPreferences(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  emitChange();
  return next;
}

export function getProductionAllRoles(): boolean {
  return loadToolsPreferences().productionAllRoles;
}

export function subscribeToolsPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearToolsPreferencesForTesting(): void {
  cached = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
