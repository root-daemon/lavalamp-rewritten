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

The default suite matrix uses every model in `bench/constants.ts` with 30 runs
per test. For a bounded smoke run, select one model, one run, and concurrency
one before starting the interactive suite picker:

```bash
SECURITYBENCH_TEST_RUNS=1 \
SECURITYBENCH_MAX_CONCURRENCY=1 \
SECURITYBENCH_MODELS=cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash \
bun run cli
```

The default Lavalamp backend runs at concurrency `4`. Additional configuration:

```bash
SECURITYBENCH_LAVALAMP_BIN=/path/to/bin/lavalamp bun run cli
SECURITYBENCH_MAX_CONCURRENCY=8 bun run cli
SECURITYBENCH_TEST_RUNS=1 bun run cli
SECURITYBENCH_MODELS=cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash bun run cli
SECURITYBENCH_RUNNER=ai-sdk bun run cli
```

`SECURITYBENCH_RUNNER` accepts only `lavalamp` or `ai-sdk`. Results, cache
reuse, scoring, Markdown reports, and visualizer input keep existing formats.
Scoring requires the complete canonical answer after trimming outer whitespace;
extra prose, Markdown, partial matches, and multiple answers fail.

## Custom suites

Add a JSON file to `bench/tests/` with a unique `id`, a `name`, a
`system_prompt`, and a `tests` array. Every test supplies a prompt, one or more
canonical `answers`, and optional `negative_answers`. The CLI discovers JSON
suites in that directory automatically.

`tests/lavalamp-quality-test.json` is a four-case example covering repository
discovery, scoped editing, verification, and bounded benchmark execution. The
bounded command above makes four model calls when this suite is selected.
