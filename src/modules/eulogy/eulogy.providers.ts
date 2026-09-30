import { env } from '../../config/env.js';
import type { EulogyProvider } from '../../generated/prisma/enums.js';

/**
 * AI eulogy generation. [GAP §5] the client has NOT chosen a provider
 * (OpenAI / Anthropic / Google) and has NOT decided stored-vs-fresh. We build
 * provider-agnostic: a single `generateEulogy()` selects the implementation from
 * EULOGY_PROVIDER (default ANTHROPIC). Switching providers is an env change.
 *
 * [GAP §5 open] the exact guided-prompt template comes from the product team;
 * `buildPrompt` holds a reasonable default that should be replaced with theirs.
 * Language is English at MVP.
 */

export interface EulogyRequest {
  deceasedName: string;
  relationship?: string;
  // Free-form guided answers captured by the app (template TBD by product team).
  promptAnswers: Record<string, unknown>;
  tone?: 'warm' | 'formal' | 'celebratory' | 'reflective';
}

export interface EulogyResult {
  text: string;
  provider: EulogyProvider;
  model: string;
}

// Recognized guided-prompt keys (optional, additive) — when present in
// promptAnswers, these are surfaced first with friendlier labels. Any other
// keys still fall into the generic dump below, so arbitrary/legacy
// promptAnswers shapes keep working exactly as before.
const GUIDED_KEYS = ['coreMemory', 'characterOrFeeling', 'legacyOrLesson'] as const;
const GUIDED_LABELS: Record<(typeof GUIDED_KEYS)[number], string> = {
  coreMemory: 'A core memory that captures who they were',
  characterOrFeeling: 'A defining trait or how they made people feel',
  legacyOrLesson: 'A lesson or legacy they leave behind',
};

function buildPrompt(req: EulogyRequest): string {
  const answers = req.promptAnswers;
  const isGuidedKey = (k: string): k is (typeof GUIDED_KEYS)[number] =>
    (GUIDED_KEYS as readonly string[]).includes(k);

  const guidedEntries = GUIDED_KEYS.filter(
    (k) => answers[k] !== undefined && answers[k] !== null && answers[k] !== '',
  ).map((k) => `- ${GUIDED_LABELS[k]}: ${typeof answers[k] === 'string' ? answers[k] : JSON.stringify(answers[k])}`);

  const otherEntries = Object.entries(answers)
    .filter(([k]) => !isGuidedKey(k))
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

  const facts = [...guidedEntries, ...otherEntries].join('\n');
  const tone = req.tone ?? 'warm';
  return [
    `Write a heartfelt eulogy for ${req.deceasedName}.`,
    req.relationship ? `It is written from the perspective of their ${req.relationship}.` : '',
    `Tone: ${tone}. Length: roughly 350–500 words. Write in English.`,
    `Use the following details; do not invent facts that contradict them:`,
    facts || '- (no specific details provided)',
    `Return only the eulogy text, with no preamble or headings.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const DEFAULT_MODELS: Record<EulogyProvider, string> = {
  ANTHROPIC: 'claude-haiku-4-5-20251001', // Haiku for cost — a eulogy draft doesn't need Sonnet-level reasoning
  OPENAI: 'gpt-4o',
  GOOGLE: 'gemini-1.5-pro',
};

export async function generateEulogy(req: EulogyRequest): Promise<EulogyResult> {
  const provider = env.EULOGY_PROVIDER as EulogyProvider;
  const model = env.EULOGY_MODEL || DEFAULT_MODELS[provider];
  const prompt = buildPrompt(req);

  switch (provider) {
    case 'ANTHROPIC':
      return { text: await callAnthropic(model, prompt), provider, model };
    case 'OPENAI':
      return { text: await callOpenAI(model, prompt), provider, model };
    case 'GOOGLE':
      return { text: await callGoogle(model, prompt), provider, model };
    default:
      throw new Error(`Unsupported eulogy provider: ${provider}`);
  }
}

// ── Provider implementations ──────────────────────────────────────────────────
// Each is isolated so the client can pick one without touching callers. Only the
// configured provider's credentials need to be set.

async function callAnthropic(model: string, prompt: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
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

async function callOpenAI(model: string, prompt: string): Promise<string> {
  // Stub: wire to OpenAI if the client selects it. Kept minimal on purpose.
  throw new Error('OpenAI provider not configured. Set EULOGY_PROVIDER=ANTHROPIC or implement callOpenAI.');
}

async function callGoogle(model: string, prompt: string): Promise<string> {
  // Stub: wire to Google (Gemini) if the client selects it.
  throw new Error('Google provider not configured. Set EULOGY_PROVIDER=ANTHROPIC or implement callGoogle.');
}
