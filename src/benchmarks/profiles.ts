import { createHash } from 'node:crypto';
import * as v from 'valibot';

const AgentProfileSchema = v.strictObject({
  schemaVersion: v.literal(1),
  name: v.pipe(v.string(), v.nonEmpty()),
  retrieval: v.picklist(['lexical', 'semantic', 'semantic_graph']),
  workflow: v.picklist(['direct', 'plan_verify']),
  orchestration: v.picklist(['solo', 'experts']),
  budget: v.picklist(['fast', 'balanced', 'deep']),
});

export type AgentProfile = v.InferOutput<typeof AgentProfileSchema>;

export interface ResolvedAgentProfile extends AgentProfile {
  fingerprint: string;
  enabledToolGroups: Array<'lexical' | 'semantic' | 'graph' | 'experts'>;
  instructions: string;
  maxSubagents: number;
  timeoutSeconds: number;
  compaction: { keepRecentTokens: number; reserveTokens: number };
}

const BUDGETS = {
  fast: {
    timeoutSeconds: 300,
    compaction: { keepRecentTokens: 4_000, reserveTokens: 12_000 },
  },
  balanced: {
    timeoutSeconds: 900,
    compaction: { keepRecentTokens: 8_000, reserveTokens: 20_000 },
  },
  deep: {
    timeoutSeconds: 1_800,
    compaction: { keepRecentTokens: 12_000, reserveTokens: 32_000 },
  },
} as const;

export function parseAgentProfile(input: unknown): AgentProfile {
  const result = v.safeParse(AgentProfileSchema, input);
  if (!result.success) {
    const details = result.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`Invalid agent profile: ${details}`);
  }
  return result.output;
}

export function resolveAgentProfile(
  profile: AgentProfile,
): ResolvedAgentProfile {
  const enabledToolGroups: ResolvedAgentProfile['enabledToolGroups'] = [
    'lexical',
  ];
  if (profile.retrieval !== 'lexical') {
    enabledToolGroups.push('semantic');
  }
  if (profile.retrieval === 'semantic_graph') {
    enabledToolGroups.push('graph');
  }
  if (profile.orchestration === 'experts') {
    enabledToolGroups.push('experts');
  }

  const instructions =
    profile.workflow === 'plan_verify'
      ? 'Before acting, make a concise plan, then verify the result with relevant checks before submitting.'
      : 'Work directly from the task and submit when the requested result is complete.';
  const normalized = JSON.stringify({
    budget: profile.budget,
    name: profile.name,
    orchestration: profile.orchestration,
    retrieval: profile.retrieval,
    schemaVersion: profile.schemaVersion,
    workflow: profile.workflow,
  });
  const budget = BUDGETS[profile.budget];

  return {
    ...profile,
    compaction: { ...budget.compaction },
    enabledToolGroups,
    fingerprint: createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 12),
    instructions,
    maxSubagents: profile.orchestration === 'experts' ? 2 : 0,
    timeoutSeconds: budget.timeoutSeconds,
  };
}
