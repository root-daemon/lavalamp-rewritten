#!/usr/bin/env bash
set -euo pipefail

cat > /app/src/config.ts <<'EOF'
export interface ModelSources {
  explicit?: string;
  environment?: string;
  configured?: string;
  fallback: string;
}

export function resolveModel(sources: ModelSources): string {
  for (const candidate of [
    sources.explicit,
    sources.environment,
    sources.configured,
    sources.fallback,
  ]) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}
EOF
