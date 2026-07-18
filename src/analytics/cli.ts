import { AnalyticsStore } from './store';
import { formatAnalyticsText } from './format';
import type { AnalyticsQuery } from './types';

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function runAnalyticsCommand(
  argv: string[],
  workspaceRoot: string,
): number {
  const scope = flagValue(argv, '--scope') ?? 'project';
  const range = flagValue(argv, '--range') ?? '30d';
  const format =
    flagValue(argv, '--format') ?? flagValue(argv, '--output-format') ?? 'text';
  if (scope !== 'project' && scope !== 'global') {
    console.error('[lavalamp] analytics --scope must be project or global');
    return 1;
  }
  if (!['7d', '30d', '90d', 'all'].includes(range)) {
    console.error('[lavalamp] analytics --range must be 7d, 30d, 90d, or all');
    return 1;
  }
  if (format !== 'text' && format !== 'json') {
    console.error('[lavalamp] analytics --format must be text or json');
    return 1;
  }

  try {
    const store = new AnalyticsStore();
    const report = store.report({
      range: range as AnalyticsQuery['range'],
      scope,
      workspaceRoot,
    });
    store.close();
    process.stdout.write(
      format === 'json'
        ? `${JSON.stringify(report)}\n`
        : `${formatAnalyticsText(report)}\n`,
    );
    return 0;
  } catch {
    console.error('[lavalamp] analytics unavailable');
    return 1;
  }
}
