import { describe, expect, test } from 'bun:test';
import {
  applyAgentProfileToTools,
  runtimeAgentProfile,
} from '../src/benchmarks/runtime-profile';

const optimized = JSON.stringify({
  budget: 'balanced',
  name: 'optimized',
  orchestration: 'experts',
  retrieval: 'semantic_graph',
  schemaVersion: 1,
  workflow: 'plan_verify',
});

describe('benchmark runtime profiles', () => {
  test('does not alter the harness when no profile is provided', () => {
    expect(runtimeAgentProfile({})).toBeNull();
  });

  test('loads a validated profile from the benchmark environment', () => {
    const profile = runtimeAgentProfile({ LAVALAMP_AGENT_PROFILE: optimized });

    expect(profile?.fingerprint).toHaveLength(12);
    expect(profile?.enabledToolGroups).toContain('graph');
  });

  test('filters retrieval and expert tools while keeping core tools', () => {
    const lexical = runtimeAgentProfile({
      LAVALAMP_AGENT_PROFILE: JSON.stringify({
        budget: 'fast',
        name: 'lexical',
        orchestration: 'solo',
        retrieval: 'lexical',
        schemaVersion: 1,
        workflow: 'direct',
      }),
    });
    const tools = [
      { name: 'read_file' },
      { name: 'ripgrep' },
      { name: 'codebase_semantic_search' },
      { name: 'codebase_graph' },
      { name: 'deploy_parallel_subs' },
      { name: 'query_expert' },
    ];

    expect(applyAgentProfileToTools(tools, lexical).map((tool) => tool.name)).toEqual([
      'read_file',
      'ripgrep',
    ]);
  });
});
