import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BenchmarkRun, TaskTrialResult } from './types';
import type { ResolvedAgentProfile } from './profiles';

export interface BenchmarkReference {
  id: string;
  kind: 'registry' | 'path';
  reference: string;
  version: string;
}

export interface HarborRunConfig {
  benchmark: BenchmarkReference;
  profile: ResolvedAgentProfile;
  model: string;
  outputDir: string;
  jobName: string;
  agentImportPath: string;
  concurrency: number;
  sample?: number;
  seed?: number;
}

export interface HarborInvocation {
  args: string[];
  env: Record<string, string>;
  config: HarborRunConfig;
}

function profileInput(profile: ResolvedAgentProfile): string {
  return JSON.stringify({
    budget: profile.budget,
    name: profile.name,
    orchestration: profile.orchestration,
    retrieval: profile.retrieval,
    schemaVersion: profile.schemaVersion,
    workflow: profile.workflow,
  });
}

export function buildHarborInvocation(
  config: HarborRunConfig,
): HarborInvocation {
  const sourceFlag =
    config.benchmark.kind === 'registry' ? '--dataset' : '--path';
  const args = [
    'harbor',
    'run',
    sourceFlag,
    config.benchmark.reference,
    '--agent',
    config.agentImportPath,
    '--model',
    config.model,
    '--env',
    'docker',
    '--n-concurrent',
    String(Math.max(1, config.concurrency)),
    '--agent-timeout-multiplier',
    String(
      config.profile.budget === 'fast'
        ? 0.5
        : config.profile.budget === 'deep'
          ? 2
          : 1,
    ),
    '--jobs-dir',
    config.outputDir,
    '--job-name',
    config.jobName,
  ];
  if (config.sample !== undefined) {
    args.push('--n-tasks', String(Math.max(1, config.sample)));
  }
  return {
    args,
    config,
    env: {
      LAVALAMP_AGENT_PROFILE: profileInput(config.profile),
      LAVALAMP_BENCHMARK_SEED: String(config.seed ?? 0),
    },
  };
}

const AGENT_SOURCE = `import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class LavalampAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "lavalamp"

    def version(self) -> str | None:
        return os.environ.get("LAVALAMP_VERSION")

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="command -v curl >/dev/null || (apt-get update && apt-get install -y curl ca-certificates)",
        )
        install_command = os.environ.get(
            "LAVALAMP_INSTALL_COMMAND",
            "curl -fsSL https://lavalamp.marban.lol/install.sh | bash",
        )
        await self.exec_as_agent(environment, command=install_command)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        forwarded = (
            "ANTHROPIC_API_KEY",
            "CF_ACCOUNT_ID",
            "CF_API_TOKEN",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
        )
        runtime_env = {
            key: os.environ[key] for key in forwarded if key in os.environ
        }
        runtime_env.update(
            {
                "LAVALAMP_AGENT_PROFILE": os.environ.get(
                    "LAVALAMP_AGENT_PROFILE", ""
                ),
                "LAVALAMP_BENCHMARK_SEED": os.environ.get(
                    "LAVALAMP_BENCHMARK_SEED", "0"
                ),
                "LAVALAMP_MODEL": self.model_name or "",
                "LAVALAMP_WORKSPACE": "/app",
            }
        )
        prompt = shlex.quote(instruction)
        command = (
            'export PATH="$HOME/.agents/bin:$PATH"; '
            "lavalamp --sudo --quiet --output-format json -p "
            f"{prompt}"
        )
        await self.exec_as_agent(
            environment, command=command, cwd="/app", env=runtime_env
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        return None
`;

export function ensureHarborAgentAdapter(dataDir: string): {
  file: string;
  importPath: string;
  pythonPath: string;
} {
  const packageDir = join(dataDir, 'harbor_agent');
  mkdirSync(packageDir, { recursive: true });
  const init = join(packageDir, '__init__.py');
  if (!existsSync(init)) {
    writeFileSync(init, '');
  }
  const file = join(packageDir, 'lavalamp_agent.py');
  writeFileSync(file, AGENT_SOURCE);
  return {
    file,
    importPath: 'harbor_agent.lavalamp_agent:LavalampAgent',
    pythonPath: dataDir,
  };
}

function resultFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...resultFiles(path));
    } else if (entry.name === 'result.json') {
      files.push(path);
    }
  }
  return files.toSorted();
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    current = record(current)[segment];
  }
  return current;
}

function numeric(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function trialFromResult(file: string, value: unknown): TaskTrialResult {
  const raw = record(value);
  const statusText = String(raw.status ?? '').toLowerCase();
  const timedOut = /timed.?out|timeout/.test(statusText);
  const reward = numeric(
    raw.reward,
    numeric(nested(raw, 'verifier_result', 'rewards', 'reward')),
  );
  const agentResult = record(raw.agent_result);
  return {
    artifactPath: dirname(file),
    cost: numeric(agentResult.cost_usd, numeric(raw.cost_usd)),
    durationMs: numeric(raw.duration_ms),
    reward,
    status: timedOut ? 'timed_out' : reward > 0 ? 'completed' : 'failed',
    taskId: String(raw.task_name ?? raw.task_id ?? basename(dirname(file))),
    tokens: numeric(agentResult.total_tokens, numeric(raw.total_tokens)),
  };
}

export function normalizeHarborResults(options: {
  runId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  scaffold: string;
  model: string;
  profileFingerprint: string;
  completedAt: string;
  outputDir: string;
}): BenchmarkRun {
  const trials: TaskTrialResult[] = [];
  const seen = new Set<string>();
  for (const file of resultFiles(options.outputDir)) {
    try {
      const trial = trialFromResult(file, JSON.parse(readFileSync(file, 'utf8')));
      if (!seen.has(trial.taskId)) {
        seen.add(trial.taskId);
        trials.push(trial);
      }
    } catch {}
  }
  return {
    benchmarkId: options.benchmarkId,
    benchmarkVersion: options.benchmarkVersion,
    completedAt: options.completedAt,
    id: options.runId,
    model: options.model,
    observed: true,
    profileFingerprint: options.profileFingerprint,
    scaffold: options.scaffold,
    schemaVersion: 1,
    trials,
  };
}
