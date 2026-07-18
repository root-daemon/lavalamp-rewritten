import { randomUUID } from 'node:crypto';
import { listModels } from '../config/models';
import {
  listSessions as listChatSessions,
  loadSession,
} from '../tui/sessions';
import { GuiRuntime } from './runtime';
import { createGuiHostServer } from './server';

export interface GuiHostMainOptions {
  serverPath: string;
  workspace: string;
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
    serverPath: options.serverPath,
    sessionId: options.sessionId,
    workspace: options.workspace,
  });
  await runtime.start({ model: options.model, workspace: options.workspace });
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
    runtime,
    token,
    workspace: options.workspace,
  });

  process.stdout.write(`LAVALAMP_GUI_READY ${server.port} ${token}\n`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.stop(true);
      await runtime.shutdown();
      resolve();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  });
}
