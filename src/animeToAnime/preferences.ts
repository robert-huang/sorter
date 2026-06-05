export type VaListImageMode = 'character' | 'staff';

/** Rules for a single play session — snapshotted when a round starts. */
export type RoundConfig = {
  allowProduction: boolean;
  allowRelations: boolean;
  productionAllRoles: boolean;
};

export const VA_LIST_IMAGE_MODE_KEY = 'anime-to-anime-va-image-mode';
export const ROUND_CONFIG_KEY = 'anime-to-anime-round-config';
const LEGACY_ROUND_CONFIG_KEY = 'link-game-round-config';

const DEFAULT_ROUND_CONFIG: RoundConfig = {
  allowProduction: true,
  allowRelations: false,
  productionAllRoles: false,
};

export function loadVaListImageMode(): VaListImageMode {
  try {
    const raw = localStorage.getItem(VA_LIST_IMAGE_MODE_KEY);
    if (raw === 'character' || raw === 'staff') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'staff';
}

export function saveVaListImageMode(mode: VaListImageMode): void {
  try {
    localStorage.setItem(VA_LIST_IMAGE_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function loadRoundConfig(): RoundConfig {
  try {
    const raw =
      localStorage.getItem(ROUND_CONFIG_KEY) ?? localStorage.getItem(LEGACY_ROUND_CONFIG_KEY);
    if (!raw) {
      return { ...DEFAULT_ROUND_CONFIG };
    }
    const parsed = JSON.parse(raw) as Partial<RoundConfig>;
    return {
      allowProduction: parsed.allowProduction !== false,
      allowRelations: parsed.allowRelations === true,
      productionAllRoles: parsed.productionAllRoles === true,
    };
  } catch {
    return { ...DEFAULT_ROUND_CONFIG };
  }
}

export function saveRoundConfig(config: RoundConfig): void {
  try {
    localStorage.setItem(ROUND_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}
