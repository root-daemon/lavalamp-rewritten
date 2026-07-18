# Lavalamp Runner Design

## Outcome

SecurityBench can execute its existing model matrix through this checkout's `bin/lavalamp` headless interface. Existing AI SDK/OpenRouter execution remains available as an explicit backend.

## Architecture

Add a focused runner module in `bench/lavalamp-runner.ts`. It owns prompt composition, subprocess arguments, JSON response validation, timeout termination, and usage normalization. `bench/index.ts` selects `lavalamp` or `ai-sdk` once and delegates each test invocation without changing scoring, caching, reporting, or Ink progress events.

`SECURITYBENCH_RUNNER` selects `lavalamp` or `ai-sdk` and defaults to `lavalamp`. `SECURITYBENCH_LAVALAMP_BIN` overrides the executable; otherwise the adapter resolves this checkout's `bin/lavalamp`. Every configured model gets a stable `modelId`, passed through `--model` unchanged.

## Lavalamp Invocation

Each run invokes:

```text
bin/lavalamp --model <modelId> --print <composedPrompt> --output-format json --quiet
```

The composed prompt places the suite system prompt in a clearly delimited instruction block before the test prompt. The adapter parses the single JSON object from stdout and maps:

- `text` to benchmark response text;
- `usage.output` to completion tokens;
- `usage.cost.total` to cost.

Non-zero exit, malformed JSON, missing response text, and timeout become normal runner errors. The timeout kills the child process before rejecting.

## Harness Change

`bin/lavalamp` must preserve a caller-provided `PORT` and use `48392` only as fallback. This keeps concurrent external harness invocations caller-isolatable while preserving current CLI behavior.

## Tests

Unit tests cover exact argument construction, model forwarding, system/test prompt composition, JSON/usage mapping, malformed output, non-zero exit, and timeout cleanup using an injected subprocess function. A launcher regression test checks caller `PORT` preservation without starting the runtime. Existing SecurityBench dataset/scoring tests and Lavalamp tests remain unchanged.

## Non-goals

- No benchmark dataset or scoring changes.
- No visualizer rewrite.
- No persistent multi-turn session reuse.
- No provider-specific model translation; configured model IDs pass through verbatim.
