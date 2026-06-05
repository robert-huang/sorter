export const OPFS_INIT_MAX_ATTEMPTS = 5;
export const OPFS_INIT_BASE_DELAY_MS = 50;

export function opfsInitBackoffMs(attempt: number): number {
  return OPFS_INIT_BASE_DELAY_MS * attempt;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry `tryOnce` until it returns true or attempts are exhausted. */
export async function withOpfsInstallRetry(
  tryOnce: () => Promise<boolean>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  for (let attempt = 1; attempt <= OPFS_INIT_MAX_ATTEMPTS; attempt++) {
    if (await tryOnce()) {
      return true;
    }
    if (attempt < OPFS_INIT_MAX_ATTEMPTS) {
      await sleepFn(opfsInitBackoffMs(attempt));
    }
  }
  return false;
}
