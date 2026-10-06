import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { askClaude } from './ai-prompt.providers.js';
import type { AskAiPromptInput } from './ai-prompt.dto.js';
import { PLAN_AI_PROMPT_LIMIT } from '../../config/plans.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * [Plan gating] Each call to askClaude() is a real, metered Anthropic API
 * call — gate BEFORE spending it. Counted directly off AiPrompt.createdAt:
 * unlike Eulogy's regenerate, every ask here creates a brand-new row, so
 * this one table is both the history log and the quota-count source.
 *
 * PLAN_AI_PROMPT_LIMIT is `Record<SubscriptionPlan, number>` (no null/
 * unlimited tier, unlike PLAN_EULOGY_GENERATION_LIMIT) — so unlike
 * assertEulogyQuota, there is no `if (limit === null) return` escape hatch.
 */
async function assertAiPromptQuota(ownerId: string): Promise<void> {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { plan: true },
  });
  const limit = PLAN_AI_PROMPT_LIMIT[owner.plan as SubscriptionPlan];

  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const count = await prisma.aiPrompt.count({
    where: { ownerId, createdAt: { gte: startOfMonth } },
  });
  if (count >= limit) {
    throw Errors.quota(
      limit === 0
        ? 'Your plan does not include AI Q&A. Upgrade to use it.'
        : `Your plan allows up to ${limit} AI question${limit === 1 ? '' : 's'} per month. Upgrade for more, or try again next month.`,
    );
  }
}

export async function askAiPrompt(ownerId: string, input: AskAiPromptInput) {
  await assertAiPromptQuota(ownerId);

  const result = await askClaude(input.question);

  return prisma.aiPrompt.create({
    data: {
      ownerId,
      question: input.question,
      answer: result.answer,
      model: result.model,
    },
  });
}

/**
 * Owner-scoped history, NOT plan-gated — reading past Q&A costs nothing and
 * a downgrade must never hide resources already created (same rule applied
 * to listEulogies/listImageAgingJobs, neither of which quota-checks reads).
 */
export async function listAiPrompts(ownerId: string) {
  return prisma.aiPrompt.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
}
