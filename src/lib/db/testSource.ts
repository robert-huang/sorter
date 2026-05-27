import migration001 from './migrations/test/001-init.sql?raw';
import migration002 from './migrations/test/002-user-note.sql?raw';
import { registerSource, type SourceDescriptor } from './source-registry';

export const TEST_SOURCE_ID = 'test';

export const testSourceDescriptor: SourceDescriptor = {
  id: TEST_SOURCE_ID,
  migrations: [
    { version: 1, sql: migration001 },
    { version: 2, sql: migration002 },
  ],
  merge: {
    metadataTables: [{ name: 'thing', pk: ['id'], timestampCol: 'fetched_at' }],
    userDataTables: [{ name: 'user_note', pk: ['id'], timestampCol: 'updated_at' }],
  },
};

let registered = false;

/** Registers the synthetic `test` source (idempotent). */
export function ensureTestSourceRegistered(): void {
  if (registered) {
    return;
  }
  registerSource(testSourceDescriptor);
  registered = true;
}
