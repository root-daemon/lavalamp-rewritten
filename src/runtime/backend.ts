export type AgentBackend = 'flue' | 'codex';

export interface BackendResolutionOptions {
  configured?: AgentBackend;
  explicit?: AgentBackend;
  session?: AgentBackend;
}

export function parseBackend(value: string | undefined): AgentBackend | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'flue' || value === 'codex') {
    return value;
  }
  throw new Error(`Unknown backend: ${value}. Expected flue or codex.`);
}

export function resolveBackend(options: BackendResolutionOptions): AgentBackend {
  if (
    options.explicit !== undefined &&
    options.session !== undefined &&
    options.explicit !== options.session
  ) {
    throw new Error(
      `The requested session uses the ${options.session} backend, not ${options.explicit}.`,
    );
  }
  return options.explicit ?? options.session ?? options.configured ?? 'flue';
}

export function assertBackendSupported(
  backend: AgentBackend,
  platform: NodeJS.Platform = process.platform,
): void {
  if (backend === 'codex' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error('The Codex backend is supported on macOS and Linux only.');
  }
}
