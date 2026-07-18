import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hasCredentials } from '../auth/credentials';
import type { BenchmarkCatalog } from './catalog';
import { compareBenchmarkRuns } from './comparison';
import {
  createCustomBenchmark,
  listCustomBenchmarks,
  validateCustomBenchmark,
} from './custom';
import { classifyFailure, type FailureAnalysis } from './failures';
import {
  buildHarborInvocation,
  ensureHarborAgentAdapter,
  normalizeHarborResults,
  type HarborInvocation,
} from './harbor';
import {
  parseAgentProfile,
  resolveAgentProfile,
  type AgentProfile,
  type ResolvedAgentProfile,
} from './profiles';
import { BenchmarkRunStore } from './run-store';
import type { BenchmarkRun, PublicBenchmarkSnapshot } from './types';

interface CatalogLike {
  ids(): PublicBenchmarkSnapshot['id'][];
  get(
    id: PublicBenchmarkSnapshot['id'],
    refresh?: boolean,
  ): Promise<PublicBenchmarkSnapshot>;
  list(refresh?: boolean): Promise<PublicBenchmarkSnapshot[]>;
  refresh(
    id: PublicBenchmarkSnapshot['id'],
  ): Promise<PublicBenchmarkSnapshot>;
}

export interface BenchmarkCliContext {
  workspaceRoot: string;
  dataDir: string;
  harborVersion?: string;
  model?: string;
  version: string;
  catalog: CatalogLike;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  preflight: (model: string) => string[];
  executeHarbor: (invocation: HarborInvocation) => Promise<number>;
  validateHarbor?: (suitePath: string) => Promise<string[]>;
  analyzeFailure?: (
    deterministic: FailureAnalysis,
    recordedEvidence: string[],
  ) => Promise<FailureAnalysis>;
}

const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  baseline: {
    budget: 'balanced',
    name: 'baseline',
    orchestration: 'solo',
    retrieval: 'lexical',
    schemaVersion: 1,
    workflow: 'direct',
  },
  optimized: {
    budget: 'balanced',
    name: 'optimized',
    orchestration: 'experts',
    retrieval: 'semantic_graph',
    schemaVersion: 1,
    workflow: 'plan_verify',
  },
};

function optionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      values.push(args[index + 1] as string);
      index++;
    }
  }
  return values;
}

function optionValue(args: string[], flag: string): string | undefined {
  return optionValues(args, flag).at(-1);
}

function numericOption(
  args: string[],
  flag: string,
  fallback: number,
): number {
  const value = Number(optionValue(args, flag));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function outputJson(args: string[]): boolean {
  return (
    args.includes('--json') || optionValue(args, '--output-format') === 'json'
  );
}

function writeOutput(
  ctx: BenchmarkCliContext,
  args: string[],
  value: unknown,
  text: string,
): void {
  ctx.stdout(outputJson(args) ? JSON.stringify(value) : text);
}

function suitePath(workspaceRoot: string, value: string): string {
  if (value.includes('/') || value.startsWith('.')) {
    return resolve(workspaceRoot, value);
  }
  return join(resolve(workspaceRoot), 'benchmarks', value);
}

function withinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

function loadProfile(
  workspaceRoot: string,
  reference: string,
): ResolvedAgentProfile {
  const builtin = BUILTIN_PROFILES[reference];
  if (builtin !== undefined) {
    return resolveAgentProfile(builtin);
  }
  const candidate = reference.endsWith('.json')
    ? resolve(workspaceRoot, reference)
    : join(workspaceRoot, 'benchmarks', 'profiles', `${reference}.json`);
  if (!withinWorkspace(workspaceRoot, candidate)) {
    throw new Error('Agent profile must stay inside the workspace');
  }
  if (!existsSync(candidate)) {
    throw new Error(`Agent profile not found: ${reference}`);
  }
  return resolveAgentProfile(
    parseAgentProfile(JSON.parse(readFileSync(candidate, 'utf8'))),
  );
}

function textCatalog(items: PublicBenchmarkSnapshot[]): string {
  return items
    .map((item) => {
      const status = item.runnable ? 'runnable' : 'reference-only';
      const stale = item.stale ? ' · stale' : '';
      const tasks = item.taskCount === undefined ? '' : ` · ${item.taskCount} tasks`;
      return `${item.id}\t${item.name} ${status}${tasks}${stale}`;
    })
    .join('\n');
}

async function analyzeFailures(
  run: BenchmarkRun,
  analyzer?: BenchmarkCliContext['analyzeFailure'],
): Promise<BenchmarkRun> {
  return {
    ...run,
    trials: await Promise.all(run.trials.map(async (trial) => {
      if (trial.status === 'completed' && trial.reward > 0) {
        return trial;
      }
      const deterministic = classifyFailure({
        editsMade: 0,
        environmentError: false,
        graderFeedback: '',
        relevantFilesOpened: false,
        searches: 0,
        testsRun: 0,
        timedOut: trial.status === 'timed_out',
      });
      const recordedEvidence = [
        ...deterministic.evidence,
        `Trial status: ${trial.status}`,
        `Reward: ${trial.reward}`,
        `Duration: ${trial.durationMs}ms`,
        `Tokens: ${trial.tokens}`,
      ];
      let result = deterministic;
      if (analyzer !== undefined) {
        try {
          result = await analyzer(deterministic, recordedEvidence);
        } catch {
          result = deterministic;
        }
      }
      return {
        ...trial,
        failureAnalysis: result,
        failureCategory: result.category,
      };
    })),
  };
}

async function runSuite(
  target: string,
  args: string[],
  ctx: BenchmarkCliContext,
): Promise<number> {
  let benchmark:
    | { id: string; kind: 'registry' | 'path'; reference: string; version: string }
    | undefined;
  if (
    ctx.catalog
      .ids()
      .includes(target as PublicBenchmarkSnapshot['id'])
  ) {
    const item = await ctx.catalog.get(
      target as PublicBenchmarkSnapshot['id'],
    );
    if (!item.runnable || item.harborDataset === undefined) {
      ctx.stderr(`${item.name} is reference-only and cannot be run locally.`);
      return 1;
    }
    benchmark = {
      id: item.id,
      kind: 'registry',
      reference: item.harborDataset,
      version: item.version,
    };
  } else {
    const path = suitePath(ctx.workspaceRoot, target);
    const errors = validateCustomBenchmark(ctx.workspaceRoot, path);
    if (errors.length > 0) {
      ctx.stderr(errors.join('\n'));
      return 1;
    }
    benchmark = {
      id: target,
      kind: 'path',
      reference: path,
      version: 'local',
    };
  }

  const model = optionValue(args, '--model') ?? ctx.model;
  if (model === undefined || model.length === 0) {
    ctx.stderr('A model is required; pass --model or configure a default model.');
    return 1;
  }
  const preflightErrors = ctx.preflight(model);
  if (preflightErrors.length > 0) {
    ctx.stderr(preflightErrors.join('\n'));
    return 1;
  }
  const profileRefs = optionValues(args, '--profile');
  const profiles = (profileRefs.length > 0 ? profileRefs : ['baseline']).map(
    (reference) => loadProfile(ctx.workspaceRoot, reference),
  );
  const adapter = ensureHarborAgentAdapter(ctx.dataDir);
  const experimentId = `benchmark_${Date.now()}`;
  const runStore = new BenchmarkRunStore(join(ctx.dataDir, 'runs'));
  const runs: BenchmarkRun[] = [];
  const seed = numericOption(args, '--seed', 1);
  for (const [index, profile] of profiles.entries()) {
    const runId = `${experimentId}_${index + 1}_${profile.fingerprint}`;
    const outputDir = join(ctx.dataDir, 'jobs', experimentId, profile.fingerprint);
    const invocation = buildHarborInvocation({
      agentImportPath: adapter.importPath,
      benchmark,
      concurrency: numericOption(args, '--concurrency', 1),
      jobName: runId,
      model,
      outputDir,
      profile,
      sample: optionValue(args, '--sample')
        ? numericOption(args, '--sample', 1)
        : undefined,
      seed,
    });
    invocation.env.PYTHONPATH = [
      adapter.pythonPath,
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(':');
    const code = await ctx.executeHarbor(invocation);
    if (code !== 0) {
      ctx.stderr(`Harbor failed for profile ${profile.name} with exit code ${code}`);
      return code;
    }
    let run = normalizeHarborResults({
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
      completedAt: new Date().toISOString(),
      model,
      outputDir,
      profileFingerprint: profile.fingerprint,
      runId,
      scaffold: `lavalamp@${ctx.version}`,
    });
    run = {
      ...run,
      benchmarkReference: benchmark.reference,
      harborVersion: ctx.harborVersion,
      profile: {
        budget: profile.budget,
        name: profile.name,
        orchestration: profile.orchestration,
        retrieval: profile.retrieval,
        schemaVersion: profile.schemaVersion,
        workflow: profile.workflow,
      },
      seed,
    };
    if (args.includes('--analyze')) {
      run = await analyzeFailures(run, ctx.analyzeFailure);
    }
    runStore.save(run);
    runs.push(run);
  }
  const comparison =
    runs.length > 1 ? compareBenchmarkRuns(runs) : undefined;
  const payload = { comparison, observed: true, runs };
  writeOutput(
    ctx,
    args,
    payload,
    comparison === undefined
      ? `Completed ${runs[0]?.id ?? experimentId}`
      : `Completed ${runs.length} profiles; recommended ${comparison.recommendedRunId}`,
  );
  return 0;
}

async function runDemo(
  target: string,
  args: string[],
  ctx: BenchmarkCliContext,
): Promise<number> {
  const path = suitePath(ctx.workspaceRoot, target);
  const errors = validateCustomBenchmark(ctx.workspaceRoot, path);
  if (errors.length === 0 && ctx.validateHarbor !== undefined) {
    errors.push(...(await ctx.validateHarbor(path)));
  }
  if (errors.length > 0) {
    ctx.stderr(errors.join('\n'));
    return 1;
  }

  const preflightErrors = ctx.preflight('oracle');
  if (preflightErrors.length > 0) {
    ctx.stderr(preflightErrors.join('\n'));
    return 1;
  }

  const profile = loadProfile(ctx.workspaceRoot, 'baseline');
  const runId = `${target.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}-oracle-${Date.now()}`;
  const outputDir = join(ctx.dataDir, 'demo-jobs');
  const invocation: HarborInvocation = {
    args: [
      'harbor',
      'run',
      '--path',
      path,
      '--agent',
      'oracle',
      '--env',
      'docker',
      '--n-concurrent',
      '1',
      '--jobs-dir',
      outputDir,
      '--job-name',
      runId,
      '--yes',
    ],
    config: {
      agentImportPath: 'oracle',
      benchmark: {
        id: target,
        kind: 'path',
        reference: path,
        version: 'local',
      },
      concurrency: 1,
      jobName: runId,
      model: 'oracle',
      outputDir,
      profile,
    },
    env: {},
  };
  const code = await ctx.executeHarbor(invocation);
  if (code !== 0) {
    ctx.stderr(`Benchmark demo failed with exit code ${code}`);
    return code;
  }

  const resultPath = join(outputDir, runId, 'result.json');
  writeOutput(
    ctx,
    args,
    { agent: 'oracle', resultPath, suite: target },
    `Demo completed without model API usage.\nResults: ${resultPath}\nView: harbor view ${JSON.stringify(outputDir)}`,
  );
  return 0;
}

export async function runBenchmarkCli(
  args: string[],
  ctx: BenchmarkCliContext,
): Promise<number> {
  const command = args[0] ?? 'list';
  try {
    if (command === 'list') {
      const items = await ctx.catalog.list(args.includes('--refresh'));
      const custom = listCustomBenchmarks(ctx.workspaceRoot).map((suite) => ({
        ...suite,
        kind: 'custom' as const,
        name: suite.id,
        runnable: true,
      }));
      const customText = custom
        .map((suite) => `${suite.id}\t${suite.name} runnable · custom`)
        .join('\n');
      writeOutput(
        ctx,
        args,
        [...items, ...custom],
        [textCatalog(items), customText].filter(Boolean).join('\n'),
      );
      return 0;
    }
    if (command === 'show') {
      const id = args[1] as PublicBenchmarkSnapshot['id'] | undefined;
      if (id === undefined || !ctx.catalog.ids().includes(id)) {
        throw new Error(`Unknown benchmark: ${id ?? ''}`);
      }
      const item = await ctx.catalog.get(id, args.includes('--refresh'));
      writeOutput(ctx, args, item, `${item.name}\n${item.description}\n${textCatalog([item])}`);
      return 0;
    }
    if (command === 'refresh') {
      const id = args[1];
      let items: PublicBenchmarkSnapshot[];
      if (id === undefined || id === 'all') {
        items = await ctx.catalog.list(true);
      } else if (
        ctx.catalog.ids().includes(id as PublicBenchmarkSnapshot['id'])
      ) {
        items = [
          await ctx.catalog.refresh(id as PublicBenchmarkSnapshot['id']),
        ];
      } else {
        throw new Error(`Unknown benchmark: ${id}`);
      }
      writeOutput(ctx, args, items, textCatalog(items));
      return 0;
    }
    if (command === 'init') {
      const name = args[1];
      if (name === undefined) {
        throw new Error('Usage: lavalamp benchmark init <name>');
      }
      const path = createCustomBenchmark(ctx.workspaceRoot, name);
      writeOutput(ctx, args, { path }, `Created benchmark: ${path}`);
      return 0;
    }
    if (command === 'validate') {
      const target = args[1];
      if (target === undefined) {
        throw new Error('Usage: lavalamp benchmark validate <name-or-path>');
      }
      const path = suitePath(ctx.workspaceRoot, target);
      const errors = validateCustomBenchmark(ctx.workspaceRoot, path);
      if (errors.length === 0 && ctx.validateHarbor !== undefined) {
        errors.push(...(await ctx.validateHarbor(path)));
      }
      const payload = { errors, path, valid: errors.length === 0 };
      if (errors.length > 0 && !outputJson(args)) {
        ctx.stderr(errors.join('\n'));
      } else {
        writeOutput(
          ctx,
          args,
          payload,
          `Benchmark is valid: ${path}`,
        );
      }
      return errors.length === 0 ? 0 : 1;
    }
    if (command === 'run') {
      const target = args[1];
      if (target === undefined) {
        throw new Error('Usage: lavalamp benchmark run <name-or-path>');
      }
      return runSuite(target, args.slice(2), ctx);
    }
    if (command === 'demo') {
      const targetArg = args[1];
      const hasTarget = targetArg !== undefined && !targetArg.startsWith('-');
      const target = hasTarget ? targetArg : 'lavalamp-quality';
      return runDemo(target, args.slice(hasTarget ? 2 : 1), ctx);
    }
    if (command === 'results') {
      const store = new BenchmarkRunStore(join(ctx.dataDir, 'runs'));
      const id = args[1];
      const value = id === undefined ? store.list() : store.load(id);
      if (value === null) {
        throw new Error(`Benchmark run not found: ${id}`);
      }
      writeOutput(ctx, args, value, JSON.stringify(value, null, 2));
      return 0;
    }
    throw new Error(`Unknown benchmark command: ${command}`);
  } catch (error: unknown) {
    ctx.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function defaultBenchmarkPreflight(model: string): string[] {
  const errors: string[] = [];
  if (Bun.spawnSync(['harbor', '--version']).exitCode !== 0) {
    errors.push('Harbor is required. Install it with: uv tool install harbor');
  }
  if (Bun.spawnSync(['docker', 'info']).exitCode !== 0) {
    errors.push('Docker must be installed and running.');
  }
  if (model.startsWith('openai/') && !process.env.OPENAI_API_KEY) {
    errors.push('OPENAI_API_KEY is required for the selected model.');
  }
  if (model.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
    errors.push('ANTHROPIC_API_KEY is required for the selected model.');
  }
  if (model.startsWith('cloudflare-workers-ai/') && !hasCredentials()) {
    errors.push(
      'Cloudflare credentials are required. Run lavalamp login or set CF_ACCOUNT_ID and CF_API_TOKEN.',
    );
  }
  return errors;
}

export async function executeHarbor(
  invocation: HarborInvocation,
): Promise<number> {
  const child = Bun.spawn(invocation.args, {
    env: { ...process.env, ...invocation.env },
    stderr: 'inherit',
    stdout: 'inherit',
  });
  return child.exited;
}

export async function validateHarborSuite(path: string): Promise<string[]> {
  try {
    const child = Bun.spawn(
      [
        'harbor',
        'run',
        '--path',
        path,
        '--agent',
        'oracle',
        '--print-config',
        '--quiet',
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    const [, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return exitCode === 0
      ? []
      : [`Harbor validation failed: ${stderr.trim() || `exit code ${exitCode}`}`];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      `Harbor validation could not run: ${message}. Install Harbor with: uv tool install harbor`,
    ];
  }
}

export type { BenchmarkCatalog };
