export type SourceMigration = { version: number; sql: string };

export type SourceMergeTable = {
  name: string;
  pk: string[];
  timestampCol: 'fetched_at' | 'updated_at';
};

export type SourceMergeSpec = {
  metadataTables: SourceMergeTable[];
  userDataTables: SourceMergeTable[];
};

export type SourceDescriptor = {
  id: string;
  migrations: SourceMigration[];
  merge: SourceMergeSpec;
};

const registry = new Map<string, SourceDescriptor>();

export function registerSource(d: SourceDescriptor): void {
  if (registry.has(d.id)) {
    throw new Error(`source '${d.id}' already registered`);
  }
  registry.set(d.id, d);
}

export function getSource(id: string): SourceDescriptor {
  const s = registry.get(id);
  if (!s) {
    throw new Error(`source '${id}' not registered`);
  }
  return s;
}

export function maxMigrationVersion(source: SourceDescriptor): number {
  if (source.migrations.length === 0) {
    return 0;
  }
  return Math.max(...source.migrations.map((m) => m.version));
}

export function listSources(): SourceDescriptor[] {
  return [...registry.values()];
}
