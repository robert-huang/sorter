import {
  exec,
  exportBytes,
  openSourceDb,
  pullMerge,
} from '../client';
import { TEST_SOURCE_ID } from '../testSource';

const statusEl = document.getElementById('status')!;
const logEl = document.getElementById('log')!;

function log(line: string): void {
  logEl.textContent += `${line}\n`;
}

async function run(): Promise<void> {
  const { schemaVersion, storageMode } = await openSourceDb(TEST_SOURCE_ID);
  log(`Opened '${TEST_SOURCE_ID}' — schema v${schemaVersion}, storage: ${storageMode}`);

  await exec(
    TEST_SOURCE_ID,
    "INSERT INTO thing (id, label, fetched_at) VALUES (?, ?, ?)",
    ['smoke-1', 'before merge', Date.now() - 1000],
  );

  const exported = await exportBytes(TEST_SOURCE_ID);
  log(`Exported ${exported.byteLength} bytes`);

  await exec(
    TEST_SOURCE_ID,
    "INSERT INTO thing (id, label, fetched_at) VALUES (?, ?, ?)",
    ['smoke-2', 'only local', Date.now()],
  );

  const mergedBytes = await pullMerge(TEST_SOURCE_ID, exported);
  log(`pullMerge returned ${mergedBytes.byteLength} bytes`);

  const rows = await exec(
    TEST_SOURCE_ID,
    'SELECT id, label, fetched_at FROM thing ORDER BY id',
  );
  log(`Rows after merge:\n${JSON.stringify(rows, null, 2)}`);

  statusEl.textContent = 'Smoke test passed';
}

run().catch((err: Error) => {
  statusEl.textContent = 'Smoke test failed';
  statusEl.className = 'err';
  log(err.stack ?? err.message);
});
