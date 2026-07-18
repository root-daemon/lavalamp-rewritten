import { describe, expect, test } from 'bun:test';
import {
  codexSessionPolicy,
  isSupportedCodexVersion,
  parseCodexVersion,
  shouldAutoApproveCodexRequest,
} from '../src/runtime/codex/runtime.ts';
import { approvalResponse } from '../src/runtime/codex/approvals.ts';
import { reconstructCodexMessages } from '../src/runtime/codex/history.ts';

describe('Codex runtime policy', () => {
  test('parses and gates Codex CLI versions', () => {
    expect(parseCodexVersion('codex-cli 0.144.5\n')).toEqual([0, 144, 5]);
    expect(isSupportedCodexVersion('codex-cli 0.144.4')).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 0.143.9')).toBe(false);
    expect(isSupportedCodexVersion('unknown')).toBe(false);
  });

  test('keeps normal build and auto-approve inside a networkless workspace', () => {
    expect(codexSessionPolicy('build', false, false)).toEqual({
      approvalPolicy: 'on-request',
      autoApprove: false,
      sandbox: 'workspace-write',
    });
    expect(codexSessionPolicy('build', true, false)).toEqual({
      approvalPolicy: 'on-request',
      autoApprove: true,
      sandbox: 'workspace-write',
    });
  });

  test('makes ask and plan read-only and sudo explicit full access', () => {
    expect(codexSessionPolicy('ask', false, false)).toEqual({
      approvalPolicy: 'never',
      autoApprove: false,
      sandbox: 'read-only',
    });
    expect(codexSessionPolicy('plan', false, false)).toEqual({
      approvalPolicy: 'never',
      autoApprove: false,
      sandbox: 'read-only',
    });
    expect(codexSessionPolicy('build', false, true)).toEqual({
      approvalPolicy: 'never',
      autoApprove: false,
      sandbox: 'danger-full-access',
    });
  });

  test('--yes stays inside the existing sandbox', () => {
    expect(shouldAutoApproveCodexRequest('item/commandExecution/requestApproval', {
      command: 'bun test',
    })).toBe(true);
    expect(shouldAutoApproveCodexRequest('item/commandExecution/requestApproval', {
      networkApprovalContext: { host: 'example.com' },
    })).toBe(false);
    expect(shouldAutoApproveCodexRequest('item/fileChange/requestApproval', {
      grantRoot: '/outside',
    })).toBe(false);
    expect(shouldAutoApproveCodexRequest('item/permissions/requestApproval', {
      permissions: { network: true },
    })).toBe(false);
  });
});

describe('Codex approvals', () => {
  test('maps command and file decisions to Codex protocol values', () => {
    expect(approvalResponse('item/commandExecution/requestApproval', 'allow', {})).toEqual({ decision: 'accept' });
    expect(approvalResponse('item/fileChange/requestApproval', 'always', {})).toEqual({ decision: 'acceptForSession' });
    expect(approvalResponse('item/fileChange/requestApproval', 'deny', {})).toEqual({ decision: 'decline' });
  });

  test('grants exactly requested permissions and supports session scope', () => {
    const params = { permissions: { fileSystem: { write: ['/repo/shared'] } } };
    expect(approvalResponse('item/permissions/requestApproval', 'allow', params)).toEqual({
      permissions: params.permissions,
      scope: 'turn',
    });
    expect(approvalResponse('item/permissions/requestApproval', 'always', params)).toEqual({
      permissions: params.permissions,
      scope: 'session',
    });
    expect(approvalResponse('item/permissions/requestApproval', 'deny', params)).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });
});

describe('Codex history reconstruction', () => {
  test('reconstructs user, reasoning, tools, and assistant output from canonical turns', () => {
    const messages = reconstructCodexMessages({
      turns: [{
        id: 'turn-1',
        items: [
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Fix it' }] },
          { type: 'reasoning', id: 'r', summary: ['Inspecting'], content: [] },
          { type: 'commandExecution', id: 'c', command: 'bun test', cwd: '/repo', status: 'completed', aggregatedOutput: 'ok', exitCode: 0, durationMs: 4 },
          { type: 'agentMessage', id: 'a', text: 'Fixed.' },
        ],
      }],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ content: 'Fix it', id: 'u', role: 'user' });
    expect(messages[1]).toMatchObject({
      content: 'Fixed.',
      id: 'a',
      role: 'assistant',
      thinking: 'Inspecting',
      toolCalls: [{ id: 'c', name: 'commandExecution', result: { exitCode: 0, output: 'ok', status: 'completed' } }],
    });
  });
});
