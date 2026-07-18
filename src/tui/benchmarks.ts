import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
} from '@opentui/core';
import type { CliRenderer, KeyEvent } from '@opentui/core';
import type {
  BenchmarkRun,
  PublicBenchmarkSnapshot,
} from '../benchmarks/types';
import { COLORS } from './theme';

export type BenchmarkBrowserTab =
  | 'overview'
  | 'runs'
  | 'failures'
  | 'provenance';

export interface BenchmarkBrowserEntry {
  id: string;
  label: string;
  kind: 'public' | 'custom' | 'run';
  snapshot?: PublicBenchmarkSnapshot;
  customPath?: string;
  run?: BenchmarkRun;
}

export interface BenchmarkBrowserModel {
  entries: BenchmarkBrowserEntry[];
  runs: BenchmarkRun[];
  selected: number;
  tab: BenchmarkBrowserTab;
}

const TABS: BenchmarkBrowserTab[] = [
  'overview',
  'runs',
  'failures',
  'provenance',
];

export function createBenchmarkBrowserModel(
  snapshots: PublicBenchmarkSnapshot[],
  custom: Array<{ id: string; path: string }>,
  runs: BenchmarkRun[],
): BenchmarkBrowserModel {
  return {
    entries: [
      ...snapshots.map((snapshot) => ({
        id: snapshot.id,
        kind: 'public' as const,
        label: snapshot.name,
        snapshot,
      })),
      ...custom.map((suite) => ({
        customPath: suite.path,
        id: suite.id,
        kind: 'custom' as const,
        label: suite.id,
      })),
      ...runs.map((run) => ({
        id: run.id,
        kind: 'run' as const,
        label: run.id,
        run,
      })),
    ],
    runs,
    selected: 0,
    tab: 'overview',
  };
}

export function moveBenchmarkSelection(
  model: BenchmarkBrowserModel,
  delta: number,
): void {
  model.selected = Math.max(
    0,
    Math.min(model.entries.length - 1, model.selected + delta),
  );
}

export function nextBenchmarkTab(model: BenchmarkBrowserModel): void {
  const index = TABS.indexOf(model.tab);
  model.tab = TABS[(index + 1) % TABS.length] as BenchmarkBrowserTab;
}

function selectedRuns(
  model: BenchmarkBrowserModel,
  entry: BenchmarkBrowserEntry,
): BenchmarkRun[] {
  if (entry.kind === 'run' && entry.run !== undefined) {
    return [entry.run];
  }
  return model.runs.filter((run) => run.benchmarkId === entry.id);
}

function score(run: BenchmarkRun): number {
  if (run.trials.length === 0) {
    return 0;
  }
  return (
    (run.trials.reduce((sum, trial) => sum + trial.reward, 0) * 100) /
    run.trials.length
  );
}

export function renderBenchmarkDetails(model: BenchmarkBrowserModel): string {
  const entry = model.entries[model.selected];
  if (entry === undefined) {
    return 'No benchmarks found. Run `lavalamp benchmark refresh` or create a custom suite.';
  }
  const runs = selectedRuns(model, entry);
  if (model.tab === 'overview') {
    if (entry.snapshot !== undefined) {
      const top = entry.snapshot.leaderboard[0];
      return [
        entry.snapshot.description,
        '',
        `version     ${entry.snapshot.version}`,
        `tasks       ${entry.snapshot.taskCount ?? 'not published'}`,
        `availability ${entry.snapshot.runnable ? 'runnable' : 'reference-only'}`,
        `freshness   ${entry.snapshot.stale ? 'stale cache' : entry.snapshot.retrievedAt}`,
        top === undefined
          ? 'public best no leaderboard rows parsed'
          : `public best ${top.score.toFixed(2)}% · ${top.name}`,
        runs[0] === undefined
          ? 'local best  no saved runs'
          : `local latest ${score(runs[0]).toFixed(2)}% · ${runs[0].profileFingerprint}`,
      ].join('\n');
    }
    if (entry.run !== undefined) {
      return [
        `benchmark   ${entry.run.benchmarkId}@${entry.run.benchmarkVersion}`,
        `score       ${score(entry.run).toFixed(2)}%`,
        `tasks       ${entry.run.trials.length}`,
        `profile     ${entry.run.profileFingerprint}`,
        `scaffold    ${entry.run.scaffold}`,
        `completed   ${entry.run.completedAt}`,
      ].join('\n');
    }
    return `Repository-owned Harbor suite\n\npath ${entry.customPath ?? ''}\nrun  lavalamp benchmark run ${entry.id}`;
  }
  if (model.tab === 'runs') {
    if (runs.length === 0) {
      return 'No saved runs for this benchmark.';
    }
    return runs
      .map(
        (run) =>
          `${run.completedAt}  ${score(run).toFixed(2)}%  ${run.profileFingerprint}  ${run.trials.length} tasks`,
      )
      .join('\n');
  }
  if (model.tab === 'failures') {
    const counts = new Map<string, number>();
    for (const run of runs) {
      for (const trial of run.trials) {
        if (trial.reward < 1) {
          const category = trial.failureCategory ?? 'unknown';
          counts.set(category, (counts.get(category) ?? 0) + 1);
        }
      }
    }
    return counts.size === 0
      ? 'No classified failures.'
      : [...counts.entries()]
          .toSorted((a, b) => b[1] - a[1])
          .map(([category, count]) => `${category.padEnd(14)} ${count}`)
          .join('\n');
  }
  if (entry.snapshot === undefined) {
    return entry.customPath ?? 'Local run data';
  }
  return [
    `retrieved ${entry.snapshot.retrievedAt}`,
    `status    ${entry.snapshot.stale ? 'stale' : 'current'}`,
    '',
    ...entry.snapshot.sourceUrls,
  ].join('\n');
}

function renderBrowser(
  renderer: CliRenderer,
  overlay: BoxRenderable,
  nextId: () => string,
  model: BenchmarkBrowserModel,
): void {
  for (const child of overlay.getChildren()) {
    child.destroy();
  }
  overlay.add(
    new TextRenderable(renderer, {
      attributes: TextAttributes.BOLD,
      content: ' lavalamp benchmarks',
      fg: COLORS.accent,
      height: 1,
      id: nextId(),
      width: '100%',
    }),
  );
  const split = new BoxRenderable(renderer, {
    flexDirection: 'row',
    flexGrow: 1,
    id: nextId(),
    width: '100%',
  });
  const left = new BoxRenderable(renderer, {
    borderColor: COLORS.border,
    borderStyle: 'single',
    flexDirection: 'column',
    id: nextId(),
    paddingLeft: 1,
    paddingRight: 1,
    width: '36%',
  });
  left.add(
    new TextRenderable(renderer, {
      attributes: TextAttributes.BOLD,
      content: 'SUITES & RUNS',
      fg: COLORS.link,
      id: nextId(),
    }),
  );
  left.add(
    new TextRenderable(renderer, {
      content:
        model.entries.length === 0
          ? '  no benchmark data'
          : model.entries
              .map((entry, index) => {
                const marker = index === model.selected ? '›' : ' ';
                const type =
                  entry.kind === 'public'
                    ? entry.snapshot?.runnable
                      ? 'public'
                      : 'reference'
                    : entry.kind;
                return `${marker} ${entry.label}\n    ${type}`;
              })
              .join('\n'),
      fg: COLORS.gray,
      id: nextId(),
      width: '100%',
    }),
  );
  const right = new BoxRenderable(renderer, {
    borderColor: COLORS.border,
    borderStyle: 'single',
    flexDirection: 'column',
    flexGrow: 1,
    id: nextId(),
    paddingLeft: 1,
    paddingRight: 1,
  });
  right.add(
    new TextRenderable(renderer, {
      attributes: TextAttributes.BOLD,
      content: TABS.map((tab) => (tab === model.tab ? `[${tab}]` : tab)).join(
        '  ',
      ),
      fg: COLORS.link,
      id: nextId(),
      width: '100%',
    }),
  );
  right.add(
    new TextRenderable(renderer, {
      content: renderBenchmarkDetails(model),
      fg: COLORS.white,
      id: nextId(),
      selectable: true,
      width: '100%',
    }),
  );
  split.add(left);
  split.add(right);
  overlay.add(split);
  overlay.add(
    new TextRenderable(renderer, {
      content: ' ↑/↓ select  Tab change view  r refresh  Esc close',
      fg: COLORS.dim,
      height: 1,
      id: nextId(),
      width: '100%',
    }),
  );
}

export function openBenchmarkBrowser(options: {
  renderer: CliRenderer;
  overlay: BoxRenderable;
  nextId: () => string;
  model: BenchmarkBrowserModel;
  hideMainTui: () => void;
  closeViewer: (offKey: () => void) => void;
  refresh: () => Promise<BenchmarkBrowserModel>;
  onError: (message: string) => void;
}): void {
  let model = options.model;
  renderBrowser(options.renderer, options.overlay, options.nextId, model);
  options.hideMainTui();
  options.overlay.focus();
  const handler = (event: KeyEvent) => {
    if (event.name === 'escape' || event.name === 'q') {
      options.closeViewer(offKey);
      return;
    }
    if (event.name === 'up' || event.name === 'k') {
      moveBenchmarkSelection(model, -1);
    } else if (event.name === 'down' || event.name === 'j') {
      moveBenchmarkSelection(model, 1);
    } else if (event.name === 'tab') {
      nextBenchmarkTab(model);
    } else if (event.name === 'r') {
      options
        .refresh()
        .then((next) => {
          model = next;
          renderBrowser(options.renderer, options.overlay, options.nextId, model);
        })
        .catch((error: unknown) =>
          options.onError(error instanceof Error ? error.message : String(error)),
        );
      return;
    } else {
      return;
    }
    renderBrowser(options.renderer, options.overlay, options.nextId, model);
    event.stopPropagation();
  };
  options.renderer.keyInput.on('keypress', handler);
  const offKey = () => options.renderer.keyInput.off('keypress', handler);
}
