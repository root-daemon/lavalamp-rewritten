import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import type { PublicBenchmarkSnapshot } from './types';

const SnapshotSchema = v.looseObject({
  schemaVersion: v.literal(1),
  id: v.picklist(['terminal-bench-2', 'swe-atlas-qna', 'cursorbench']),
  name: v.string(),
  version: v.string(),
  description: v.string(),
  categories: v.array(v.string()),
  metrics: v.array(v.string()),
  leaderboard: v.array(
    v.looseObject({
      rank: v.number(),
      name: v.string(),
      score: v.number(),
    }),
  ),
  sourceUrls: v.array(v.string()),
  retrievedAt: v.string(),
  stale: v.boolean(),
  runnable: v.boolean(),
});

export interface BenchmarkSource {
  id: PublicBenchmarkSnapshot['id'];
  fetch(): Promise<PublicBenchmarkSnapshot>;
}

function validateSnapshot(value: unknown): PublicBenchmarkSnapshot {
  const result = v.safeParse(SnapshotSchema, value);
  if (!result.success) {
    throw new Error('Invalid public benchmark snapshot');
  }
  return value as PublicBenchmarkSnapshot;
}

function writeSnapshot(file: string, snapshot: PublicBenchmarkSnapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(pending, file);
}

export class BenchmarkCatalog {
  private readonly sources: Map<string, BenchmarkSource>;

  constructor(
    private readonly cacheDir: string,
    sources: BenchmarkSource[],
  ) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
  }

  ids(): PublicBenchmarkSnapshot['id'][] {
    return [...this.sources.keys()] as PublicBenchmarkSnapshot['id'][];
  }

  readCached(
    id: PublicBenchmarkSnapshot['id'],
  ): PublicBenchmarkSnapshot | null {
    const file = join(this.cacheDir, `${id}.json`);
    if (!existsSync(file)) {
      return null;
    }
    try {
      return validateSnapshot(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  async get(
    id: PublicBenchmarkSnapshot['id'],
    refresh = false,
  ): Promise<PublicBenchmarkSnapshot> {
    const cached = this.readCached(id);
    if (cached !== null && !refresh) {
      return cached;
    }
    return this.refresh(id);
  }

  async refresh(
    id: PublicBenchmarkSnapshot['id'],
  ): Promise<PublicBenchmarkSnapshot> {
    const source = this.sources.get(id);
    if (source === undefined) {
      throw new Error(`Unknown benchmark source: ${id}`);
    }
    try {
      const snapshot = validateSnapshot(await source.fetch());
      mkdirSync(this.cacheDir, { recursive: true });
      const target = join(this.cacheDir, `${id}.json`);
      const timestamp = snapshot.retrievedAt.replaceAll(/[^0-9A-Za-z-]/g, '-');
      writeSnapshot(
        join(this.cacheDir, id, `${timestamp}.json`),
        snapshot,
      );
      writeSnapshot(target, snapshot);
      return snapshot;
    } catch (error: unknown) {
      const cached = this.readCached(id);
      if (cached !== null) {
        return { ...cached, stale: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to refresh ${id}: ${message}`);
    }
  }

  async list(refresh = false): Promise<PublicBenchmarkSnapshot[]> {
    return Promise.all(this.ids().map((id) => this.get(id, refresh)));
  }
}
