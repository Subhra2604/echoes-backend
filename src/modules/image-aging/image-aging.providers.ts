import { env } from '../../config/env.js';

/**
 * AI age-progression image generation via Google Gemini 2.5 Flash Image
 * ("Nano Banana"). Mirrors eulogy.providers.ts's shape: env-driven, raw
 * fetch (no SDK dependency), one exported entry point, isolated per-provider
 * call function so a second provider is a small diff, not a rewrite.
 *
 * NOT the same as EULOGY_PROVIDER=GOOGLE (that's an unrelated, currently-
 * stubbed *text* model, gemini-1.5-pro) — different model, different API
 * shape, different feature.
 *
 * Verified 2026-09-30: the client-provided key works from a pure server-to-
 * server call (not platform-restricted to a mobile app context).
 */

export interface AgeProgressionRequest {
  imageBytes: Buffer;
  sourceMimeType: string;
  ageOffset: 10 | 20 | 50;
}

export interface AgeProgressionResult {
  imageBytes: Buffer;
  mimeType: string;
  model: string;
}

const GEMINI_MODEL = 'gemini-2.5-flash-image';

function buildAgingPrompt(ageOffset: 10 | 20 | 50): string {
  return (
    `Age this person by approximately ${ageOffset} years. Preserve facial ` +
    `identity, bone structure, and proportions. Apply realistic skin, hair, ` +
    `and feature aging consistent with natural aging. Keep pose, lighting, ` +
    `and background unchanged. Return only the edited photo, no text.`
  );
}

export async function generateAgedImage(req: AgeProgressionRequest): Promise<AgeProgressionResult> {
  // Single provider today; kept as a thin dispatcher (matching
  // eulogy.providers.ts's generateEulogy()) so a future second provider
  // (e.g. fal.ai Flux Kontext as a fallback) is additive, not a rewrite.
  return callGeminiImage(req);
}

async function callGeminiImage(req: AgeProgressionRequest): Promise<AgeProgressionResult> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildAgingPrompt(req.ageOffset) },
              {
                inline_data: {
                  mime_type: req.sourceMimeType,
                  data: req.imageBytes.toString('base64'),
                },
              },
            ],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data: string; mimeType: string } }> };
      finishReason?: string;
    }>;
  };

  // The response can contain multiple parts (and even multiple inlineData
  // parts, observed in testing) — take the first image part found.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData)?.inlineData;
  if (!imagePart) {
    const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown';
    throw new Error(`Gemini returned no image (finishReason: ${finishReason})`);
  }

  return {
    imageBytes: Buffer.from(imagePart.data, 'base64'),
    mimeType: imagePart.mimeType,
    model: GEMINI_MODEL,
  };
}
