import type {
  LeaderboardRow,
  PublicBenchmarkSnapshot,
} from './types';
import type { BenchmarkSource } from './catalog';

const TERMINAL_TASKS_URL =
  'https://www.tbench.ai/benchmarks/terminal-bench-2';
const TERMINAL_LEADERBOARD_URL =
  'https://www.tbench.ai/leaderboard/terminal-bench/2.0';
const SWE_ATLAS_URL = 'https://labs.scale.com/leaderboard/sweatlas-qna';
const CURSORBENCH_URL = 'https://cursor.com/cursorbench';
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function quotedStrings(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

function uniqueRows(rows: LeaderboardRow[]): LeaderboardRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.name}\0${row.score}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function parseTerminalBenchHtml(
  tasksHtml: string,
  leaderboardHtml: string,
  retrievedAt = new Date().toISOString(),
): PublicBenchmarkSnapshot {
  const taskCount = Number(
    tasksHtml.match(
      /Showing(?:\s|<!--.*?-->)*(\d+)(?:\s|<!--.*?-->)*tasks/i,
    )?.[1],
  );
  const leaderboard: LeaderboardRow[] = [];
  const normalized = leaderboardHtml.replaceAll('\\"', '"');
  const pattern =
    /\{"agent":"([^"]+)".*?"model":\[(.*?)\].*?"accuracy":([0-9.]+)/g;
  for (const match of normalized.matchAll(pattern)) {
    leaderboard.push({
      model: quotedStrings(match[2] as string).join(' + '),
      name: match[1] as string,
      rank: leaderboard.length + 1,
      score: Number(match[3]) * 100,
    });
  }
  return {
    categories: ['terminal', 'coding', 'system-administration'],
    description:
      'Hard, realistic tasks completed by autonomous agents in containerized terminal environments.',
    harborDataset: 'terminal-bench/terminal-bench-2',
    id: 'terminal-bench-2',
    leaderboard: uniqueRows(leaderboard),
    metrics: ['resolve_rate'],
    name: 'Terminal-Bench 2.0',
    retrievedAt,
    runnable: true,
    schemaVersion: 1,
    sourceUrls: [TERMINAL_TASKS_URL, TERMINAL_LEADERBOARD_URL],
    stale: false,
    taskCount: Number.isFinite(taskCount) ? taskCount : undefined,
    version: '2.0',
  };
}

export function parseSweAtlasHtml(
  html: string,
  retrievedAt = new Date().toISOString(),
): PublicBenchmarkSnapshot {
  const taskCount = Number(
    html.match(/Codebase QnA consists of(?:\s|<!--.*?-->)*(\d+) tasks/i)?.[1],
  );
  const leaderboard: LeaderboardRow[] = [];
  const normalized = html.replaceAll('\\"', '"');
  const pattern =
    /\{"model":"([^"]+)".*?"rank":(\d+),"score":([0-9.]+)/g;
  for (const match of normalized.matchAll(pattern)) {
    leaderboard.push({
      name: match[1] as string,
      rank: Number(match[2]),
      score: Number(match[3]),
    });
  }
  return {
    categories: ['codebase-understanding', 'question-answering'],
    description:
      'Repository-level questions requiring runtime analysis and multi-file reasoning.',
    harborDataset: 'scale-ai/swe-atlas-qna',
    id: 'swe-atlas-qna',
    leaderboard: uniqueRows(leaderboard).toSorted((a, b) => a.rank - b.rank),
    metrics: ['task_resolve_rate'],
    name: 'SWE Atlas - Codebase QnA',
    retrievedAt,
    runnable: true,
    schemaVersion: 1,
    sourceUrls: [
      SWE_ATLAS_URL,
      'https://huggingface.co/datasets/ScaleAI/SWE-Atlas-QnA',
    ],
    stale: false,
    taskCount: Number.isFinite(taskCount) ? taskCount : undefined,
    version: '1',
  };
}

export function parseCursorBenchHtml(
  html: string,
  retrievedAt = new Date().toISOString(),
): PublicBenchmarkSnapshot {
  const version = html.match(/CursorBench\s+(\d+\.\d+)/i)?.[1] ?? 'unknown';
  const leaderboard: LeaderboardRow[] = [];
  const pattern =
    /aria-label="([^"]+?):\s*([0-9.]+)%,\s*\$([0-9.]+) avg cost per task"/g;
  for (const match of html.matchAll(pattern)) {
    leaderboard.push({
      cost: Number(match[3]),
      name: match[1] as string,
      rank: 0,
      score: Number(match[2]),
    });
  }
  const ranked = uniqueRows(leaderboard)
    .toSorted((a, b) => b.score - a.score || (a.cost ?? 0) - (b.cost ?? 0))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    categories: ['coding', 'multi-file', 'agentic'],
    description:
      'Private, real-session coding tasks used by Cursor to compare agent and model quality.',
    id: 'cursorbench',
    leaderboard: ranked,
    metrics: ['score', 'average_cost_per_task'],
    name: `CursorBench ${version}`,
    retrievedAt,
    runnable: false,
    schemaVersion: 1,
    sourceUrls: [CURSORBENCH_URL],
    stale: false,
    version,
  };
}

export async function fetchOfficialText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'lavalamp-benchmark-catalog/1' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Benchmark source ${url} returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    throw new Error(`Benchmark source ${url} exceeded the 8 MiB limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
    throw new Error(`Benchmark source ${url} exceeded the 8 MiB limit`);
  }
  return text;
}

export function officialBenchmarkSources(
  fetchText: (url: string) => Promise<string> = fetchOfficialText,
): BenchmarkSource[] {
  return [
    {
      id: 'terminal-bench-2',
      async fetch() {
        const [tasks, leaderboard] = await Promise.all([
          fetchText(TERMINAL_TASKS_URL),
          fetchText(TERMINAL_LEADERBOARD_URL),
        ]);
        return parseTerminalBenchHtml(tasks, leaderboard);
      },
    },
    {
      id: 'swe-atlas-qna',
      async fetch() {
        return parseSweAtlasHtml(await fetchText(SWE_ATLAS_URL));
      },
    },
    {
      id: 'cursorbench',
      async fetch() {
        return parseCursorBenchHtml(await fetchText(CURSORBENCH_URL));
      },
    },
  ];
}
