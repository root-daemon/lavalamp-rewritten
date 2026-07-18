import {
  parseAgentProfile,
  resolveAgentProfile,
  type ResolvedAgentProfile,
} from './profiles';

const TOOL_GROUPS = {
  semantic: new Set(['codebase_semantic_search']),
  graph: new Set(['codebase_graph']),
  experts: new Set(['deploy_parallel_subs', 'query_expert']),
};

export function runtimeAgentProfile(
  env: Record<string, string | undefined>,
): ResolvedAgentProfile | null {
  const raw = env.LAVALAMP_AGENT_PROFILE;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  try {
    return resolveAgentProfile(parseAgentProfile(JSON.parse(raw)));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid LAVALAMP_AGENT_PROFILE: ${message}`);
  }
}

export function applyAgentProfileToTools<T extends { name: string }>(
  tools: T[],
  profile: ResolvedAgentProfile | null,
): T[] {
  if (profile === null) {
    return tools;
  }
  const groups = new Set(profile.enabledToolGroups);
  return tools.filter((tool) => {
    if (TOOL_GROUPS.semantic.has(tool.name)) {
      return groups.has('semantic');
    }
    if (TOOL_GROUPS.graph.has(tool.name)) {
      return groups.has('graph');
    }
    if (TOOL_GROUPS.experts.has(tool.name)) {
      return groups.has('experts');
    }
    return true;
  });
}
