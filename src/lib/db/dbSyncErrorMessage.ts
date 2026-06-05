import {
  MEMORY_MODE_PUSH_BLOCKED,
  NO_REMOTE,
  REMOTE_DRIFTED,
  REMOTE_SCHEMA_NEWER,
} from './sync';

export function dbSyncErrorMessage(err: unknown): string {
  const e = err as Error & { code?: string };
  if (e.code === REMOTE_DRIFTED) {
    return 'Remote has new changes — pull first.';
  }
  if (e.code === REMOTE_SCHEMA_NEWER) {
    return 'App is out of date — please reload.';
  }
  if (e.code === NO_REMOTE) {
    return 'No cloud copy yet — push first.';
  }
  if (e.code === MEMORY_MODE_PUSH_BLOCKED) {
    return 'Push blocked: non-persistent tab. Close other tabs of this app and reload, then push.';
  }
  return e.message || 'Sync failed.';
}
