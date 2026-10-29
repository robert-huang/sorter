import { useSyncExternalStore } from 'react';
import type { RescaleTarget } from './panels/scoreComparisonLogic';

/** The User Scores panel publishes its first user's 0–100 fit for the settings menu. */
export type ScoreComparisonFit = { username: string; target: RescaleTarget };

let currentFit: ScoreComparisonFit | null = null;
const listeners = new Set<() => void>();

export function publishScoreComparisonFit(fit: ScoreComparisonFit | null): void {
  const same =
    fit?.username === currentFit?.username &&
    fit?.target.mean === currentFit?.target.mean &&
    fit?.target.stdDev === currentFit?.target.stdDev;
  if (same) return;
  currentFit = fit;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useScoreComparisonFit(): ScoreComparisonFit | null {
  return useSyncExternalStore(subscribe, () => currentFit);
}
