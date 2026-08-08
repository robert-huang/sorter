export type CacheOwnerStats = {
  entries: number;
  bytes: number;
};

export type DisposableCacheOwner = {
  id: string;
  label: string;
  /** Why deleting this owner cannot remove user-created or correctness data. */
  deletionEffect: string;
  measure: () => Promise<CacheOwnerStats>;
  clear: () => Promise<void>;
  clearUnderPressure?: () => Promise<void>;
};

export type DisposableCacheCleanupResult = {
  ownerId: string;
  ok: boolean;
  error: string | null;
};

const owners = new Map<string, DisposableCacheOwner>();
let lastCleanupResults: DisposableCacheCleanupResult[] = [];

export function registerDisposableCacheOwner(
  owner: DisposableCacheOwner,
): () => void {
  owners.set(owner.id, owner);
  return () => {
    if (owners.get(owner.id) === owner) {
      owners.delete(owner.id);
    }
  };
}

export function listDisposableCacheOwners(): DisposableCacheOwner[] {
  return [...owners.values()];
}

export async function measureDisposableCacheOwners(): Promise<
  Array<DisposableCacheOwner & { stats: CacheOwnerStats }>
> {
  return Promise.all(
    listDisposableCacheOwners().map(async (owner) => ({
      ...owner,
      stats: await owner.measure().catch(() => ({ entries: 0, bytes: 0 })),
    })),
  );
}

async function runCleanup(
  selectedOwners: readonly DisposableCacheOwner[],
  pressure: boolean,
): Promise<DisposableCacheCleanupResult[]> {
  const results: DisposableCacheCleanupResult[] = [];
  for (const owner of selectedOwners) {
    try {
      if (pressure && owner.clearUnderPressure) {
        await owner.clearUnderPressure();
      } else {
        await owner.clear();
      }
      results.push({ ownerId: owner.id, ok: true, error: null });
    } catch (error) {
      results.push({
        ownerId: owner.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Cache cleanup failed.',
      });
    }
  }
  lastCleanupResults = results;
  return results;
}

export function clearDisposableCacheOwner(
  ownerId: string,
): Promise<DisposableCacheCleanupResult[]> {
  const owner = owners.get(ownerId);
  return runCleanup(owner ? [owner] : [], false);
}

export function clearDisposableCacheOwners(
  ownerIds: readonly string[],
): Promise<DisposableCacheCleanupResult[]> {
  const selected = ownerIds.flatMap((ownerId) => {
    const owner = owners.get(ownerId);
    return owner ? [owner] : [];
  });
  return runCleanup(selected, false);
}

export function clearAllDisposableCaches(): Promise<
  DisposableCacheCleanupResult[]
> {
  return runCleanup(listDisposableCacheOwners(), false);
}

export function clearDisposableCachesUnderPressure(): Promise<
  DisposableCacheCleanupResult[]
> {
  return runCleanup(listDisposableCacheOwners(), true);
}

export function getLastDisposableCacheCleanupResults(): DisposableCacheCleanupResult[] {
  return [...lastCleanupResults];
}

/** Test-only registry reset. */
export function _resetDisposableCacheRegistryForTesting(): void {
  owners.clear();
  lastCleanupResults = [];
}
