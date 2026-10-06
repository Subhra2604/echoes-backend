import { env } from '../../config/env.js';

/**
 * One-shot AI Q&A. Every question is answered independently — no
 * conversation memory, no prior-question context, no RAG over the user's own
 * vault/memories/data. Claude (Anthropic) only, by explicit product
 * decision: unlike eulogy.providers.ts's multi-provider scaffold (which
 * stubs OpenAI/Google behind an env switch), this file intentionally has no
 * such abstraction, to keep this feature's maintenance surface minimal.
 *
 * Raw `fetch` against the Messages API, same as eulogy.providers.ts — the
 * `@anthropic-ai/sdk` package is not a dependency of this repo and adding it
 * for one call site isn't worth it. ANTHROPIC_API_KEY already exists in
 * config/env.ts and is already set in production; no new env var needed.
 */

// Haiku: same cost/quality tradeoff eulogy.providers.ts makes — a direct Q&A
// answer doesn't need Sonnet-level reasoning for the vast majority of
// questions this feature will see, and quota (PLAN_AI_PROMPT_LIMIT) assumes
// Haiku-level cost per call.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1500;

export interface AiPromptResult {
  answer: string;
  model: string;
}

export async function askClaude(question: string): Promise<AiPromptResult> {
  const answer = await callAnthropic(question);
  return { answer, model: MODEL };
}

async function callAnthropic(prompt: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}
