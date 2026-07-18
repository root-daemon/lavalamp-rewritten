import * as v from 'valibot';
import type { BenchmarkFailureCategory } from './types';

export interface FailureSignals {
  environmentError: boolean;
  timedOut: boolean;
  relevantFilesOpened: boolean;
  searches: number;
  editsMade: number;
  testsRun: number;
  graderFeedback: string;
}

export interface FailureAnalysis {
  schemaVersion: 1;
  method: 'deterministic' | 'llm';
  category: BenchmarkFailureCategory;
  confidence: number;
  summary: string;
  evidence: string[];
  recommendedChange?: ProfileChangeRecommendation;
}

export type ProfileChangeRecommendation =
  | { field: 'retrieval'; value: 'lexical' | 'semantic' | 'semantic_graph'; rationale: string }
  | { field: 'workflow'; value: 'direct' | 'plan_verify'; rationale: string }
  | { field: 'orchestration'; value: 'solo' | 'experts'; rationale: string }
  | { field: 'budget'; value: 'fast' | 'balanced' | 'deep'; rationale: string };

const RecommendationSchema = v.variant('field', [
  v.strictObject({
    field: v.literal('retrieval'),
    rationale: v.pipe(v.string(), v.nonEmpty()),
    value: v.picklist(['lexical', 'semantic', 'semantic_graph']),
  }),
  v.strictObject({
    field: v.literal('workflow'),
    rationale: v.pipe(v.string(), v.nonEmpty()),
    value: v.picklist(['direct', 'plan_verify']),
  }),
  v.strictObject({
    field: v.literal('orchestration'),
    rationale: v.pipe(v.string(), v.nonEmpty()),
    value: v.picklist(['solo', 'experts']),
  }),
  v.strictObject({
    field: v.literal('budget'),
    rationale: v.pipe(v.string(), v.nonEmpty()),
    value: v.picklist(['fast', 'balanced', 'deep']),
  }),
]);

const LlmFailureAnalysisSchema = v.strictObject({
  category: v.picklist([
    'environment',
    'retrieval',
    'reasoning',
    'execution',
    'verification',
    'resource',
    'submission',
    'unknown',
  ]),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  evidence: v.pipe(v.array(v.string()), v.minLength(1)),
  recommendedChange: RecommendationSchema,
  summary: v.pipe(v.string(), v.nonEmpty()),
});

function analysis(
  category: BenchmarkFailureCategory,
  confidence: number,
  summary: string,
  evidence: string[],
  recommendedChange?: ProfileChangeRecommendation,
): FailureAnalysis {
  return {
    category,
    confidence,
    evidence,
    method: 'deterministic',
    recommendedChange,
    schemaVersion: 1,
    summary,
  };
}

export function parseLlmFailureAnalysis(
  response: string,
  recordedEvidence: string[],
): FailureAnalysis {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const json = fenced?.[1]?.trim() ?? response.trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('LLM failure analysis did not return valid JSON');
  }
  const result = v.safeParse(LlmFailureAnalysisSchema, value);
  if (!result.success) {
    throw new Error('LLM failure analysis did not match the required schema');
  }
  const allowed = new Set(recordedEvidence);
  if (result.output.evidence.some((item) => !allowed.has(item))) {
    throw new Error('LLM failure analysis cited unrecorded evidence');
  }
  return {
    ...result.output,
    method: 'llm',
    schemaVersion: 1,
  };
}

export function classifyFailure(signals: FailureSignals): FailureAnalysis {
  if (signals.environmentError) {
    return analysis(
      'environment',
      1,
      'The task environment failed before a valid agent result was produced.',
      ['Environment setup or execution reported an error'],
    );
  }
  if (signals.timedOut) {
    return analysis(
      'resource',
      1,
      'The agent exhausted the task time budget.',
      ['The trial reached its timeout'],
      {
        field: 'budget',
        rationale: 'Allow more time for the same task and model.',
        value: 'deep',
      },
    );
  }
  if (!signals.relevantFilesOpened && signals.searches > 0) {
    return analysis(
      'retrieval',
      0.9,
      'The agent searched the repository without reaching the relevant files.',
      [
        'Relevant files were never opened',
        `${signals.searches} search operations were recorded`,
      ],
      {
        field: 'retrieval',
        rationale: 'Broaden repository discovery beyond lexical search.',
        value: 'semantic',
      },
    );
  }
  if (signals.editsMade > 0 && signals.testsRun === 0) {
    return analysis(
      'verification',
      0.9,
      'The agent changed the workspace without running a verification command.',
      [`${signals.editsMade} edits and no test runs were recorded`],
      {
        field: 'workflow',
        rationale: 'Require verification before submission.',
        value: 'plan_verify',
      },
    );
  }
  if (/format|path|clean worktree|read.?only/i.test(signals.graderFeedback)) {
    return analysis(
      'submission',
      0.8,
      'The submitted artifact violated an output or workspace requirement.',
      [signals.graderFeedback],
    );
  }
  if (signals.relevantFilesOpened) {
    return analysis(
      signals.editsMade > 0 ? 'execution' : 'reasoning',
      0.6,
      signals.editsMade > 0
        ? 'The agent found relevant evidence but the implementation did not pass.'
        : 'The agent found relevant evidence but did not produce a passing answer.',
      ['Relevant files were opened before submission'],
    );
  }
  return analysis(
    'unknown',
    0.2,
    'The available trajectory does not contain enough evidence to classify the failure.',
    [],
  );
}
