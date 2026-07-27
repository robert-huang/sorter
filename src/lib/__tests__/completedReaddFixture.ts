import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Item, MergeState } from '../types';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/completedReadd.json',
);

export type CompletedReaddFixture = {
  items: Record<string, Item>;
  progress: MergeState;
  /** [beforeAdd, penultimate] snapshots from the repro save. */
  undoRing: [MergeState, MergeState];
};

export function loadCompletedReaddFixture(): CompletedReaddFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CompletedReaddFixture;
}
