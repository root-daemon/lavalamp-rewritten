import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listModels } from '../config/models';
import type { AgentBackend } from '../runtime/backend';
import { parseBackend } from '../runtime/backend';
import { getDefaultRules, loadRules } from '../permissions/rules';
import { copyTextToClipboard } from '../storage/clipboard';
import { discoverSkills } from '../tui/discover';
import { HELP_COMMANDS, HELP_KEYS } from '../tui/slash-data';
import {
  listSessions as listChatSessions,
  loadSession,
} from '../tui/sessions';
import type { GuiCommandResult } from './contracts';
import { GuiRuntime } from './runtime';
import { createGuiHostServer } from './server';

export interface GuiHostMainOptions {
  serverPath: string;
  workspace: string;
  backend?: AgentBackend;
  model?: string;
  agentName?: string;
  sessionId?: string;
  port?: number;
  token?: string;
}

export async function runGuiHost(options: GuiHostMainOptions): Promise<void> {
  const token = options.token ?? randomUUID();
  const runtime = GuiRuntime.create({
    agentName: options.agentName,
    backend: options.backend,
    model: options.model,
    serverPath: options.serverPath,
    sessionId: options.sessionId,
    workspace: options.workspace,
  });
  const server = createGuiHostServer({
    listModels,
    listSessions: () =>
      listChatSessions().map((session) => ({
        messageCount: session.messageCount,
        prompt: session.name,
        savedAt: session.savedAt,
        sessionId: session.id,
      })),
    loadSession: (sessionId) =>
      loadSession(sessionId)
        ?.filter((message) => message.role !== 'system')
        .map((message) => ({
          content: message.content,
          role: message.role as 'user' | 'assistant',
        })) ?? null,
    port: options.port,
    runCommand: (command) =>
      runGuiCommand(runtime, options.workspace, options.serverPath, command),
    runtime,
    token,
    workspace: options.workspace,
  });

  process.stdout.write(`LAVALAMP_GUI_READY ${server.port} ${token}\n`);
  const runtimeStart = runtime
    .start({ model: options.model, workspace: options.workspace })
    .catch((error: unknown) => {
      runtime.store.append({
        message: error instanceof Error ? error.message : String(error),
        type: 'turn.failed',
      });
    });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(orphanCheck);
      server.stop(true);
      await runtimeStart;
      await runtime.shutdown();
      resolve();
    };
    const orphanCheck = setInterval(() => {
      if (process.ppid <= 1) void stop();
    }, 1000);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  });
}

async function runGuiCommand(
  runtime: GuiRuntime,
  workspace: string,
  serverPath: string,
  raw: string,
): Promise<GuiCommandResult> {
  const command = raw.trim();
  const cmd = command.split(/\s+/)[0]?.toLowerCase() ?? '';
  const arg = command.slice(cmd.length).trim();
  switch (cmd) {
    case '/help':
      return {
        title: '/help',
        rows: [
          'Commands:',
          ...HELP_COMMANDS.map(([name, desc]) => `${name.padEnd(14)} ${desc}`),
          '',
          'Keys:',
          ...HELP_KEYS.map(([key, desc]) => `${key.padEnd(14)} ${desc}`),
        ],
      };
    case '/clear':
      runtime.cancel();
      runtime.store.resetConversation();
      return { title: '/clear', rows: ['Started a clean GUI session.'] };
    case '/sessions': {
      const sessions = listChatSessions();
      return {
        title: '/sessions',
        rows:
          sessions.length === 0
            ? ['No saved sessions.']
            : sessions.map(
                (session) =>
                  `${session.id}  ${session.name}  ${session.messageCount} messages`,
              ),
      };
    }
    case '/compact': {
      const before = runtime.store.snapshot().messages.length;
      await runtime.compact();
      const after = runtime.store.snapshot().messages.length;
      return {
        title: '/compact',
        rows: [`Kept last ${after} of ${before} messages.`],
      };
    }
    case '/memory':
      return readProjectMemory(workspace);
    case '/model':
    case '/models': {
      if (arg.length > 0) {
        await runtime.setModel(arg);
        return {
          title: cmd,
          rows: [`model set: ${arg}`],
        };
      }
      const models = (await runtime.listModels()).length > 0
        ? await runtime.listModels()
        : listModels();
      return {
        title: cmd,
        rows: models.map((model) =>
          `${model.id}${model.displayName === undefined ? '' : `  ${model.displayName}`}`,
        ),
      };
    }
    case '/backend': {
      if (arg.length > 0) {
        const backend = parseBackend(arg);
        if (backend === undefined) {
          return { title: '/backend', rows: ['usage: /backend flue|codex'] };
        }
        await runtime.setBackend(backend);
        return {
          title: '/backend',
          rows: [`backend set: ${backend}; started a clean session`],
        };
      }
      const snapshot = runtime.store.snapshot();
      return {
        title: '/backend',
        rows: [
          `backend: ${snapshot.backend ?? 'flue'}`,
          'usage: /backend flue|codex',
        ],
      };
    }
    case '/login':
      return {
        title: '/login',
        rows: [
          'GUI host is connected.',
          'If runtime auth fails, run `lavalamp login` in a terminal.',
        ],
      };
    case '/benchmark':
    case '/benchmarks':
      return {
        title: cmd,
        rows: ['Benchmark browser is TUI-only in this build.'],
      };
    case '/gateway':
      return {
        title: '/gateway',
        rows: ['Gateway status and switching are TUI-only in this build.'],
      };
    case '/usage': {
      const usage = runtime.store.snapshot().usage;
      return {
        title: '/usage',
        rows: [
          `total: ${usage.totalTokens} tokens - $${usage.cost.toFixed(4)}`,
          `input: ${usage.input} - output: ${usage.output}`,
          `cache read: ${usage.cacheRead} - cache write: ${usage.cacheWrite}`,
        ],
      };
    }
    case '/analytics':
      return {
        title: '/analytics',
        rows: ['Analytics browser is TUI-only in this build.'],
      };
    case '/rate':
      return {
        title: '/rate',
        rows: ['Run rating is TUI-only in this build.'],
      };
    case '/workspace':
      return { title: '/workspace', rows: [`workspace: ${workspace}`] };
    case '/skills': {
      const skills = discoverSkills(workspace);
      return {
        title: '/skills',
        rows: skills.length === 0 ? ['No skills found.'] : skills.map((skill) => `#${skill}`),
      };
    }
    case '/mcp':
      return readMcpConfig();
    case '/tools':
      return readRegisteredTools(serverPath);
    case '/subagents':
      return { title: '/subagents', rows: ['No GUI subagent registry events yet.'] };
    case '/sudo':
      return {
        title: '/sudo',
        rows: ['Sudo mode is TUI-only in this build. Use permission buttons per tool.'],
      };
    case '/permissions': {
      const rules = loadRules(workspace);
      return {
        title: '/permissions',
        rows: (rules.length > 0 ? rules : getDefaultRules()).map((rule) => {
          const qualifier =
            rule.commandClass !== undefined
              ? ` (${rule.commandClass} shell)`
              : rule.argPattern !== undefined
                ? ` (${rule.argPattern})`
                : '';
          return `${rule.action.padEnd(5)} ${rule.tool}${qualifier}`;
        }),
      };
    }
    case '/copy':
    {
      const transcript = runtime.store.snapshot().messages
        .map((message) => `${message.role === 'user' ? '> ' : '~ '}${message.content}`)
        .join('\n\n');
      return {
        title: '/copy',
        rows: [
          transcript.length > 0 && copyTextToClipboard(transcript)
            ? 'Session copied to clipboard.'
            : 'No transcript available to copy.',
        ],
      };
    }
    case '/build':
      await runtime.setMode('build');
      return {
        title: '/build',
        rows: ['mode set: build'],
      };
    case '/plan': {
      await runtime.setMode('plan');
      return {
        title: '/plan',
        rows: ['mode set: plan'],
      };
    }
    case '/ask':
      await runtime.setMode('ask');
      return {
        title: '/ask',
        rows: ['mode set: ask'],
      };
    case '/undo':
      await runtime.undo();
      return {
        title: '/undo',
        rows: ['Last turn removed from GUI session.'],
      };
    case '/paste-image':
      return {
        title: '/paste-image',
        rows: ['Image paste is TUI-only in this build.'],
      };
    case '/quit':
      return { title: '/quit', rows: ['Close the Lavalamp window to exit.'] };
    default:
      return { title: cmd || '/command', rows: [`unknown command: ${cmd}`] };
  }
}

function readProjectMemory(workspace: string): GuiCommandResult {
  try {
    const lines = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
      .split('\n')
      .slice(0, 30);
    return { title: '/memory', rows: lines.length === 0 ? ['AGENTS.md is empty.'] : lines };
  } catch {
    return { title: '/memory', rows: ['No AGENTS.md found.'] };
  }
}

function readMcpConfig(): GuiCommandResult {
  const home = process.env.HOME;
  if (home === undefined) return { title: '/mcp', rows: ['HOME unavailable.'] };
  try {
    const raw = readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
    const cfg = JSON.parse(raw) as {
      mcp?: Record<string, unknown>;
      mcpServers?: Record<string, unknown>;
    };
    const servers = cfg.mcpServers ?? cfg.mcp ?? {};
    const names = Object.keys(servers);
    return {
      title: '/mcp',
      rows: names.length === 0 ? ['No MCP servers configured.'] : names,
    };
  } catch {
    return { title: '/mcp', rows: ['No MCP config found.'] };
  }
}

function readRegisteredTools(serverPath: string): GuiCommandResult {
  try {
    const content = readFileSync(serverPath, 'utf8');
    const toolNames = new Set<string>();
    for (const match of content.matchAll(/name:\s*["']([^"']+)["']/g)) {
      if (match[1] !== undefined) toolNames.add(match[1]);
    }
    return {
      title: '/tools',
      rows:
        toolNames.size === 0
          ? ['No tools found in harness.']
          : [...toolNames].toSorted(),
    };
  } catch {
    return { title: '/tools', rows: ['Could not read harness build.'] };
  }
}
