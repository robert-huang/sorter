export type StorageCategory =
  | 'user-data'
  | 'setting'
  | 'credential'
  | 'disposable-cache'
  | 'migration'
  | 'transient';

export type StorageBacking =
  | 'localStorage'
  | 'sessionStorage'
  | 'indexedDB'
  | 'cacheStorage'
  | 'opfs'
  | 'memory'
  | 'googleDrive';

export type StorageCatalogEntry = {
  id: string;
  owner: string;
  category: StorageCategory;
  backing: StorageBacking;
  key: string;
  prefix?: boolean;
  sensitive?: boolean;
  autoEvict: boolean;
};

export type LocalStorageOwnerStats = {
  owner: string;
  entries: number;
  bytes: number;
};

const fixedToolFormKeys = [
  'anime-tools-favourites-form',
  'anime-tools-favourites-rank-limits',
  'anime-tools-shared-credits-form',
  'anime-tools-shared-staff-form',
  'anime-tools-seasonal-scores-form',
  'anime-tools-seasonal-scores-source-filters',
  'anime-tools-seasonal-scores-primary-filters',
  'anime-tools-franchise-scores-form',
  'anime-tools-franchise-scores-filters',
  'anime-tools-franchise-activities-view',
  'anime-tools-adaptation-scores-form',
  'anime-tools-adaptation-scores-filters',
  'anime-tools-stats-form',
  'anime-tools-stats-filters',
  'anime-tools-weekly-calendar-form',
  'anime-tools-update-list-entry-form',
  'anime-tools-reorder-favourites-form',
] as const;

const fixedSettingKeys = [
  'sorter:settings:v1',
  'sorter:active-slot-id:v1',
  'sorter:state-schema:v1',
  'sorter:state-revision:v1',
  'settings:lastTab',
  'sorter:start:lastTab',
  'sorter:add-items:lastTab',
  'sorter:tools:bump-chart:saved-expanded:v1',
  'anilist:lastUsername',
  'anilist:display-preferences:v1',
  'anilist:includeFormatInLabel',
  'anilist-detail-production-roles',
  'anime-tools:preferences:v1',
  'anime-tools-active-tool',
  'anime-tools:settings:lastTab',
  'anime-to-anime-theme',
  'anime-to-anime:settings:lastTab',
  'anime-to-anime-va-image-mode',
  'anime-to-anime-staff-gender-filter',
  'anime-to-anime-round-config',
  'spotify:playlist:v1',
  'spotify:local-file-match:v1',
  'spotify:theme-song-display:v1',
  'spotify:api-bans:v2',
  'sorter:cloud:folder:v1',
  'sorter:db-sync:v1',
] as const;

const legacyKeys = [
  'sorter:v1',
  'sorter:slots:v1',
  'tools:bump-chart:workspace:v1',
  'tools:bump-chart:saved-manifest:v1',
  'spotify:playlist-cache:v1',
  'spotify:playlist-cache:v2',
  'spotify:track-isrc:v1',
  'spotify:api-ban:v1',
  'link-game-round-config',
  'anime-tools-shared-credits-query',
  'anime-tools-shared-staff-query',
  'anime-tools-seasonal-scores-season-text',
] as const;

export const storageCatalog: readonly StorageCatalogEntry[] = [
  ...fixedSettingKeys.map(
    (key): StorageCatalogEntry => ({
      id: `setting:${key}`,
      owner: 'Settings',
      category: 'setting',
      backing: 'localStorage',
      key,
      autoEvict: false,
    }),
  ),
  ...fixedToolFormKeys.map(
    (key): StorageCatalogEntry => ({
      id: `tool-form:${key}`,
      owner: 'Tool forms',
      category: 'setting',
      backing: 'localStorage',
      key,
      autoEvict: false,
    }),
  ),
  {
    id: 'anilist-accounts',
    owner: 'AniList authentication',
    category: 'credential',
    backing: 'localStorage',
    key: 'anilist:accounts:v1',
    sensitive: true,
    autoEvict: false,
  },
  {
    id: 'spotify-auth',
    owner: 'Spotify authentication',
    category: 'credential',
    backing: 'localStorage',
    key: 'spotify:auth:v1',
    sensitive: true,
    autoEvict: false,
  },
  {
    id: 'google-auth',
    owner: 'Google authentication',
    category: 'credential',
    backing: 'localStorage',
    key: 'sorter:cloud:tokens:v1',
    sensitive: true,
    autoEvict: false,
  },
  {
    id: 'legacy-tools-cache',
    owner: 'Tool API cache',
    category: 'migration',
    backing: 'localStorage',
    key: 'tools-cache:',
    prefix: true,
    autoEvict: true,
  },
  {
    id: 'legacy-bump-url-cache',
    owner: 'Bump Chart image URL cache',
    category: 'migration',
    backing: 'localStorage',
    key: 'queue-sorter:bump-mal-export-image-urls:v1',
    autoEvict: true,
  },
  ...legacyKeys.map(
    (key): StorageCatalogEntry => ({
      id: `migration:${key}`,
      owner: 'Legacy migrations',
      category: 'migration',
      backing: 'localStorage',
      key,
      autoEvict: false,
    }),
  ),
  {
    id: 'legacy-sorter-slots',
    owner: 'Legacy migrations',
    category: 'migration',
    backing: 'localStorage',
    key: 'sorter:slot:',
    prefix: true,
    autoEvict: false,
  },
  {
    id: 'legacy-bump-slots',
    owner: 'Legacy migrations',
    category: 'migration',
    backing: 'localStorage',
    key: 'tools:bump-chart:saved:v1:',
    prefix: true,
    autoEvict: false,
  },
  {
    id: 'sorter-state',
    owner: 'Sorter and Bump Chart saves',
    category: 'user-data',
    backing: 'indexedDB',
    key: 'queue-sorter-state',
    autoEvict: false,
  },
  {
    id: 'disposable-values',
    owner: 'Disposable API and image metadata',
    category: 'disposable-cache',
    backing: 'indexedDB',
    key: 'queue-sorter-disposable-cache',
    autoEvict: true,
  },
  {
    id: 'spotify-playlist-cache',
    owner: 'Spotify playlist cache',
    category: 'disposable-cache',
    backing: 'indexedDB',
    key: 'queue-sorter-spotify/playlistCaches',
    autoEvict: true,
  },
  {
    id: 'spotify-track-isrc-cache',
    owner: 'Spotify track-to-ISRC mappings',
    category: 'disposable-cache',
    backing: 'indexedDB',
    key: 'queue-sorter-spotify/trackIsrcs',
    autoEvict: false,
  },
  {
    id: 'bump-image-blobs',
    owner: 'Bump Chart image cache',
    category: 'disposable-cache',
    backing: 'cacheStorage',
    key: 'queue-sorter-bump-chart-mal-export-images-v1',
    autoEvict: true,
  },
  {
    id: 'anilist-sqlite',
    owner: 'AniList source database',
    category: 'user-data',
    backing: 'opfs',
    key: 'anilist',
    autoEvict: false,
  },
  {
    id: 'reorder-deleted',
    owner: 'Reorder Favourites deleted history',
    category: 'user-data',
    backing: 'sessionStorage',
    key: 'reorder-favourites-recently-deleted',
    autoEvict: false,
  },
];

function storageStringBytes(value: string): number {
  return value.length * 2;
}

export function estimateCataloguedLocalStorage(): LocalStorageOwnerStats[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }
  const byOwner = new Map<string, LocalStorageOwnerStats>();
  const counted = new Set<string>();
  const localEntries = storageCatalog.filter(
    (entry) => entry.backing === 'localStorage',
  );

  try {
    for (const entry of localEntries) {
      const keys: string[] = [];
      if (entry.prefix) {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(entry.key)) {
            keys.push(key);
          }
        }
      } else if (localStorage.getItem(entry.key) != null) {
        keys.push(entry.key);
      }

      for (const key of keys) {
        if (counted.has(key)) {
          continue;
        }
        counted.add(key);
        const value = localStorage.getItem(key) ?? '';
        const stats = byOwner.get(entry.owner) ?? {
          owner: entry.owner,
          entries: 0,
          bytes: 0,
        };
        stats.entries += 1;
        stats.bytes += storageStringBytes(key) + storageStringBytes(value);
        byOwner.set(entry.owner, stats);
      }
    }

    const unregistered = {
      owner: 'Unregistered localStorage',
      entries: 0,
      bytes: 0,
    };
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || counted.has(key)) {
        continue;
      }
      const value = localStorage.getItem(key) ?? '';
      unregistered.entries += 1;
      unregistered.bytes +=
        storageStringBytes(key) + storageStringBytes(value);
    }
    if (unregistered.entries > 0) {
      byOwner.set(unregistered.owner, unregistered);
    }
  } catch {
    return [...byOwner.values()];
  }
  return [...byOwner.values()].sort((left, right) => right.bytes - left.bytes);
}
