import { BenchmarkCatalog } from '../benchmarks/catalog';
import { analyzeFailureWithCloudflare } from '../benchmarks/analysis-llm';
import { loadCredentials } from '../auth/credentials';
import {
  defaultBenchmarkPreflight,
  executeHarbor,
  runBenchmarkCli,
  validateHarborSuite,
} from '../benchmarks/cli';
import { officialBenchmarkSources } from '../benchmarks/sources';
import {
  benchmarkCacheDir,
  benchmarkWorkspaceDir,
} from '../storage/paths';

export async function runBenchmarkCommand(options: {
  args: string[];
  workspaceRoot: string;
  model?: string;
  version: string;
}): Promise<number> {
  const workspaceFlag = options.args.indexOf('--workspace');
  const workspaceRoot =
    workspaceFlag >= 0 && options.args[workspaceFlag + 1] !== undefined
      ? (options.args[workspaceFlag + 1] as string)
      : options.workspaceRoot;
  const catalog = new BenchmarkCatalog(
    benchmarkCacheDir(),
    officialBenchmarkSources(),
  );
  const credentials = loadCredentials();
  const harborVersionResult = Bun.spawnSync(['harbor', '--version']);
  const harborVersion =
    harborVersionResult.exitCode === 0
      ? harborVersionResult.stdout.toString().trim()
      : 'unknown';
  return runBenchmarkCli(options.args, {
    analyzeFailure: analyzeFailureWithCloudflare,
    catalog,
    dataDir: benchmarkWorkspaceDir(workspaceRoot),
    executeHarbor: (invocation) => {
      if (credentials !== null) {
        invocation.env.CF_ACCOUNT_ID = credentials.accountId;
        invocation.env.CF_API_TOKEN = credentials.apiToken;
      }
      return executeHarbor(invocation);
    },
    harborVersion,
    model: options.model,
    preflight: defaultBenchmarkPreflight,
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line),
    version: options.version,
    validateHarbor: validateHarborSuite,
    workspaceRoot,
  });
}
