import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkRun } from './types';

export class BenchmarkRunStore {
  constructor(private readonly dir: string) {}

  save(run: BenchmarkRun): void {
    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, `${run.id}.json`);
    const pending = `${target}.${process.pid}.tmp`;
    writeFileSync(pending, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(pending, target);
  }

  load(id: string): BenchmarkRun | null {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return null;
    }
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as BenchmarkRun;
    } catch {
      return null;
    }
  }

  list(): BenchmarkRun[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.load(file.slice(0, -5)))
      .filter((run): run is BenchmarkRun => run !== null)
      .toSorted((a, b) => b.completedAt.localeCompare(a.completedAt));
  }
}
