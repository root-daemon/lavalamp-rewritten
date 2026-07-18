import { randomUUID } from 'node:crypto';
import { listModels } from '../config/models';
import { listSessions } from '../sessions/store';
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
    listSessions,
    port: options.port,
    runtime,
    token,
    workspace: options.workspace,
  });

  process.stdout.write(`LAVALAMP_GUI_READY ${server.port} ${token}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await runtime.shutdown();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.once('beforeExit', () => void stop());
}
