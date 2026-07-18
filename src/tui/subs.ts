import { FlueProcess } from './ipc';
import type { FlueEvent, FlueResult } from './ipc';
import type { SubAgent } from './state';
import type { AnalyticsRecorder } from '../analytics';
import type {
  RuntimeSubagent,
  RuntimeSubagentInspection,
  RuntimeSubagentStatus,
} from '../runtime/types';

const FLUE_STATUS: Record<SubAgent['status'], RuntimeSubagentStatus> = {
  done: 'completed',
  failed: 'failed',
  killed: 'stopped',
  running: 'running',
  timed_out: 'failed',
};

export function projectFlueSubagent(subagent: SubAgent): RuntimeSubagent {
  return {
    id: subagent.id,
    name: subagent.id,
    task: subagent.query,
    status: FLUE_STATUS[subagent.status],
    startedAt: subagent.startTime,
    ...(subagent.result === undefined || subagent.result.length === 0
      ? {}
      : { result: subagent.result }),
    ...(subagent.error === undefined ? {} : { error: subagent.error }),
  };
}

export function inspectFlueSubagent(
  subagent: SubAgent,
): RuntimeSubagentInspection {
  const content = subagent.result?.trim() || subagent.error?.trim();
  return {
    messages: [
      { content: subagent.query, role: 'user' },
      ...(content === undefined
        ? []
        : [{ content, role: 'assistant' as const }]),
    ],
    subagent: projectFlueSubagent(subagent),
  };
}

export class SubAgentManager {
  private readonly subs = new Map<
    string,
    SubAgent & { process: FlueProcess }
  >();
  private readonly analyticsTurns = new Map<
    string,
    { recorder: AnalyticsRecorder; turnId: string }
  >();
  private seq = 0;

  onUpdate?: (subs: SubAgent[]) => void;
  onAllComplete?: (summary: string) => void;

  constructor(
    private readonly serverPath: string,
    private readonly cwd: string,
    private readonly agentName = 'build',
    private analytics?: AnalyticsRecorder,
    private parentTurn?: () => string | undefined,
  ) {}

  setAnalytics(
    analytics: AnalyticsRecorder,
    parentTurn?: () => string | undefined,
  ): void {
    this.analytics = analytics;
    this.parentTurn = parentTurn;
  }

  async deploy(queries: string[]): Promise<void> {
    for (const query of queries.slice(0, 3)) {
      const id = `sub-${++this.seq}`;
      const process = new FlueProcess(
        this.serverPath,
        this.cwd,
        this.agentName,
      );
      const sub: SubAgent & { process: FlueProcess } = {
        id,
        process,
        query,
        result: '',
        startTime: Date.now(),
        status: 'running',
      };
      this.subs.set(id, sub);
      this.emitUpdate();
      this.run(sub).catch((error: unknown) => this.fail(sub, error));
    }
  }

  kill(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) {
      return;
    }
    sub.process.cancel();
    sub.status = 'killed';
    const analytics = this.analyticsTurns.get(id);
    analytics?.recorder.finishTurn(analytics.turnId, 'interrupted');
    analytics?.recorder.event('subagent', 'killed', analytics.turnId);
    this.analyticsTurns.delete(id);
    this.emitUpdate();
    this.checkComplete();
  }

  killAll(): void {
    for (const sub of this.subs.values()) {
      this.kill(sub.id);
    }
  }

  getActive(): SubAgent[] {
    return this.list().filter((sub) => sub.status === 'running');
  }

  list(): SubAgent[] {
    return [...this.subs.values()].map(
      ({
        process: _process,
        id,
        query,
        result,
        startTime,
        status,
        pid,
        error,
      }) => ({ error, id, pid, query, result, startTime, status }),
    );
  }

  get(id: string): SubAgent | undefined {
    return this.list().find((subagent) => subagent.id === id);
  }

  isDeploying(): boolean {
    return this.getActive().length > 0;
  }

  private async run(sub: SubAgent & { process: FlueProcess }): Promise<void> {
    await sub.process.start();
    sub.pid = sub.process.pid;
    this.emitUpdate();

    const prompt = `Research the following and provide a detailed, structured summary: ${sub.query}\n\nFocus on: factual accuracy, key findings, relevant code references, and actionable insights.`;
    const recorder = this.analytics;
    const analyticsTurn = recorder?.startTurn('subagent', this.parentTurn?.());
    if (recorder !== undefined && analyticsTurn !== undefined) {
      this.analyticsTurns.set(sub.id, { recorder, turnId: analyticsTurn });
    }
    let stopReason: string | undefined;
    const timeout = setTimeout(() => {
      if (sub.status === 'running') {
        sub.status = 'timed_out';
        recorder?.finishTurn(analyticsTurn, 'failed');
        recorder?.event('subagent', 'timed_out', analyticsTurn);
        this.analyticsTurns.delete(sub.id);
        sub.process.cancel();
        this.emitUpdate();
        this.checkComplete();
      }
    }, 5 * 60_000);

    sub.process.prompt(prompt, {
      onError: (error) => {
        clearTimeout(timeout);
        this.fail(sub, error);
      },
      onEvent: (event: FlueEvent) => {
        if (typeof event.stopReason === 'string') {
          stopReason = event.stopReason;
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          recorder?.firstResponse(analyticsTurn);
        }
        if (event.type === 'text_delta') {
          sub.result = (sub.result ?? '') + (event.text ?? event.delta ?? '');
          this.emitUpdate();
        } else if (event.type === 'tool_start') {
          recorder?.toolStarted(
            analyticsTurn,
            event.toolCallId,
            event.toolName ?? 'unknown',
            event.args,
          );
        } else if (event.type === 'tool') {
          recorder?.toolFinished(
            analyticsTurn,
            event.toolCallId,
            event.toolName ?? 'unknown',
            event.durationMs,
            Boolean(event.isError),
          );
        }
      },
      onResult: (result: FlueResult) => {
        clearTimeout(timeout);
        sub.status = 'done';
        recorder?.finishTurn(analyticsTurn, 'completed', {
          model: result.model,
          stopReason,
          usage: result.usage,
        });
        recorder?.event('subagent', 'completed', analyticsTurn);
        this.analyticsTurns.delete(sub.id);
        sub.process.shutdown().catch(() => {});
        this.emitUpdate();
        this.checkComplete();
      },
    });
  }

  private fail(sub: SubAgent & { process: FlueProcess }, error: unknown): void {
    if (sub.status !== 'running') {
      return;
    }
    sub.status = 'failed';
    const analytics = this.analyticsTurns.get(sub.id);
    analytics?.recorder.finishTurn(analytics.turnId, 'failed');
    analytics?.recorder.event('subagent', 'failed', analytics.turnId);
    this.analyticsTurns.delete(sub.id);
    sub.error = error instanceof Error ? error.message : String(error);
    sub.process.shutdown().catch(() => {});
    this.emitUpdate();
    this.checkComplete();
  }

  private checkComplete(): void {
    if (this.subs.size === 0 || this.isDeploying()) {
      return;
    }
    const subs = this.list();
    const summary = subs.every((sub) => sub.status !== 'done')
      ? `## Research Results\n\nAll parallel research agents failed or were stopped.`
      : `## Research Results\n\n${subs
          .map((sub, i) => {
            const result = sub.result?.trim();
            return `### Query ${i + 1}: ${sub.query}\n\n${result && result.length > 0 ? result : `(${sub.status}${sub.error !== undefined ? `: ${sub.error}` : ''})`}`;
          })
          .join('\n\n')}`;
    if (this.onAllComplete !== undefined) {
      this.onAllComplete(summary);
    }
  }

  private emitUpdate(): void {
    if (this.onUpdate !== undefined) {
      this.onUpdate(this.list());
    }
  }
}
