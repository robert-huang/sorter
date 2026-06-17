export type VaListImageMode = 'character' | 'staff';

/**
 * Live filter restricting which staff links count, by AniList gender.
 * `any` keeps everyone (including missing/unknown and non-binary); `male`/
 * `female` keep only that exact gender. Unlike `RoundConfig`, this is applied
 * live (never snapshotted at round start).
 */
export type StaffGenderFilter = 'any' | 'male' | 'female';

/** Rules for a single play session — snapshotted when a round starts. */
export type RoundConfig = {
  allowProduction: boolean;
  allowRelations: boolean;
  productionAllRoles: boolean;
};

export const VA_LIST_IMAGE_MODE_KEY = 'anime-to-anime-va-image-mode';
export const STAFF_GENDER_FILTER_KEY = 'anime-to-anime-staff-gender-filter';
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

export function loadStaffGenderFilter(): StaffGenderFilter {
  try {
    const raw = localStorage.getItem(STAFF_GENDER_FILTER_KEY);
    if (raw === 'any' || raw === 'male' || raw === 'female') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'any';
}

export function saveStaffGenderFilter(filter: StaffGenderFilter): void {
  try {
    localStorage.setItem(STAFF_GENDER_FILTER_KEY, filter);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a staff member's AniList gender passes the active filter. `any`
 * matches everyone; `male`/`female` match only that exact gender, so staff
 * with missing/unknown or non-binary gender are excluded.
 */
export function matchesStaffGender(
  gender: string | null | undefined,
  filter: StaffGenderFilter,
): boolean {
  if (filter === 'any') {
    return true;
  }
  if (gender == null) {
    return false;
  }
  return gender.trim().toLowerCase() === filter;
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
