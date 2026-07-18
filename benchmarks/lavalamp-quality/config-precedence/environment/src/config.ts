export interface ModelSources {
  explicit?: string;
  environment?: string;
  configured?: string;
  fallback: string;
}

export function resolveModel(sources: ModelSources): string {
  return (
    sources.configured ??
    sources.environment ??
    sources.explicit ??
    sources.fallback
  );
}
