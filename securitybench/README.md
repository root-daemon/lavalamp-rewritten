# SecurityBench

SecurityBench runs benchmark suites through the parent Lavalamp checkout by
default. Every entry in `bench/constants.ts` keeps its benchmark label and
forwards its provider model ID to `bin/lavalamp --model`.

## Setup

```bash
cd securitybench/bench
bun install
../../bin/lavalamp status
```

Lavalamp must already have working authentication for the configured models.

## Run

```bash
cd securitybench/bench
bun run cli
```

The default Lavalamp backend runs at concurrency `4`. Configuration:

```bash
SECURITYBENCH_LAVALAMP_BIN=/path/to/bin/lavalamp bun run cli
SECURITYBENCH_MAX_CONCURRENCY=8 bun run cli
SECURITYBENCH_RUNNER=ai-sdk bun run cli
```

`SECURITYBENCH_RUNNER` accepts only `lavalamp` or `ai-sdk`. Results, cache
reuse, scoring, Markdown reports, and visualizer input keep existing formats.
