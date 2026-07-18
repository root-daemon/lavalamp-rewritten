import { loadCredentials } from '../auth/credentials';
import {
  parseLlmFailureAnalysis,
  type FailureAnalysis,
} from './failures';

const ANALYSIS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_RESPONSE_BYTES = 1_000_000;

export async function analyzeFailureWithCloudflare(
  deterministic: FailureAnalysis,
  recordedEvidence: string[],
): Promise<FailureAnalysis> {
  const credentials = loadCredentials();
  if (credentials === null) {
    throw new Error('Cloudflare credentials are required for LLM analysis');
  }
  const prompt = [
    'Analyze one failed coding-agent benchmark trial.',
    'Use only the exact evidence strings provided. Do not infer missing events.',
    'Return JSON only with: category, confidence, summary, evidence, and recommendedChange.',
    'category must be environment, retrieval, reasoning, execution, verification, resource, submission, or unknown.',
    'recommendedChange must change exactly one field: retrieval, workflow, orchestration, or budget, using a valid Lavalamp profile value, plus a rationale.',
    `Deterministic classification: ${JSON.stringify(deterministic)}`,
    `Recorded evidence: ${JSON.stringify(recordedEvidence)}`,
  ].join('\n');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/v1/chat/completions`,
    {
      body: JSON.stringify({
        max_tokens: 800,
        messages: [{ content: prompt, role: 'user' }],
        model: ANALYSIS_MODEL,
        temperature: 0,
      }),
      headers: {
        Authorization: `Bearer ${credentials.apiToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Failure analysis request failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new Error('Failure analysis response exceeded the size limit');
  }
  const payload = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Failure analysis response was empty');
  }
  return parseLlmFailureAnalysis(content, recordedEvidence);
}
