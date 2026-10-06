import { z } from 'zod';

/**
 * One-shot AI Q&A input. 2000 chars (~350-400 words) is generous for a real
 * question — including a paragraph or two of context — while still bounding
 * prompt size well under the 1,500-token response budget this feature pays
 * for per call (see ai-prompt.providers.ts).
 */
export const askAiPromptSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});

export type AskAiPromptInput = z.infer<typeof askAiPromptSchema>;
