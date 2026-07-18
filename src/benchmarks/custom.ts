import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SUITE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function write(file: string, content: string): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

export function createCustomBenchmark(
  workspaceRoot: string,
  name: string,
): string {
  if (!SUITE_NAME.test(name)) {
    throw new Error(
      'Invalid benchmark name; use lowercase letters, numbers, and hyphens',
    );
  }
  const suite = join(resolve(workspaceRoot), 'benchmarks', name);
  if (existsSync(suite)) {
    throw new Error(`Benchmark already exists: ${suite}`);
  }

  write(
    join(suite, 'dataset.toml'),
    `[dataset]\nname = "local/${name}"\ndescription = "Repository-owned Lavalamp benchmark"\nauthors = ["Lavalamp"]\nkeywords = ["lavalamp", "custom"]\n\n[[tasks]]\nname = "local/${name}-example"\n`,
  );
  write(
    join(suite, 'example', 'instruction.md'),
    '# Example task\n\nCreate `/app/answer.txt` containing exactly `lavalamp`.\n',
  );
  write(
    join(suite, 'example', 'task.toml'),
    `schema_version = "1.3"\n\n[task]\nname = "local/${name}-example"\ndescription = "Verify the custom benchmark scaffold"\n\n[agent]\ntimeout_sec = 300.0\n\n[verifier]\ntimeout_sec = 60.0\n\n[environment]\ncpus = 1\nmemory_mb = 1024\nstorage_mb = 2048\n`,
  );
  write(
    join(suite, 'example', 'environment', 'Dockerfile'),
    'FROM ubuntu:24.04\nWORKDIR /app\n',
  );
  const solution = join(suite, 'example', 'solution', 'solve.sh');
  write(solution, '#!/usr/bin/env bash\nset -euo pipefail\nprintf lavalamp > /app/answer.txt\n');
  chmodSync(solution, 0o755);
  const verifier = join(suite, 'example', 'tests', 'test.sh');
  write(
    verifier,
    '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p /logs/verifier\nif test "$(cat /app/answer.txt 2>/dev/null || true)" = lavalamp; then\n  printf 1 > /logs/verifier/reward.txt\nelse\n  printf 0 > /logs/verifier/reward.txt\nfi\n',
  );
  chmodSync(verifier, 0o755);
  return suite;
}

function withinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateCustomBenchmark(
  workspaceRoot: string,
  suitePath: string,
): string[] {
  const suite = resolve(suitePath);
  if (!withinWorkspace(workspaceRoot, suite)) {
    return ['Benchmark path must stay inside the workspace'];
  }
  const errors: string[] = [];
  if (!existsSync(join(suite, 'dataset.toml'))) {
    errors.push('Missing dataset.toml');
  }
  if (!existsSync(suite)) {
    return errors;
  }
  const tasks = readdirSync(suite, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
  );
  if (tasks.length === 0) {
    errors.push('Benchmark must contain at least one task directory');
  }
  const required = [
    'instruction.md',
    'task.toml',
    'environment/Dockerfile',
    'tests/test.sh',
  ];
  for (const task of tasks) {
    for (const file of required) {
      if (!existsSync(join(suite, task.name, file))) {
        errors.push(`Task ${task.name} is missing ${file}`);
      }
    }
  }
  return errors;
}

export function listCustomBenchmarks(workspaceRoot: string): Array<{
  id: string;
  path: string;
}> {
  const root = join(resolve(workspaceRoot), 'benchmarks');
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, entry.name, 'dataset.toml')),
    )
    .map((entry) => ({ id: entry.name, path: join(root, entry.name) }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}
