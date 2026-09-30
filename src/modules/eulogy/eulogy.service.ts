import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { generateEulogy } from './eulogy.providers.js';
import { renderEulogyPdf } from './eulogy.pdf.js';
import type { GenerateEulogyInput } from './eulogy.dto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PLAN_EULOGY_GENERATION_LIMIT } from '../../config/plans.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * Eulogy service. [GAP §5] "stored vs fresh" was not decided by the client — we
 * STORE each generated draft (the schema is versioned), which lets users edit,
 * revisit, and regenerate without paying for inference every view. Switching to
 * fresh-on-demand later only means skipping the persisted read.
 */

// [Plan gating] Each call to generateEulogy() is a real, metered Anthropic API
// call — gate BOTH createEulogy and regenerateEulogy before spending it.
// Counted via the append-only EulogyGeneration log, not Eulogy rows, because
// regenerateEulogy updates its Eulogy row in place (version bump) rather than
// creating a new one — counting Eulogy.createdAt would silently miss every
// regeneration, exactly the call this quota most needs to control.
async function assertEulogyQuota(ownerId: string): Promise<void> {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { plan: true },
  });
  const limit = PLAN_EULOGY_GENERATION_LIMIT[owner.plan as SubscriptionPlan];
  if (limit === null) return;

  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const count = await prisma.eulogyGeneration.count({
    where: { ownerId, createdAt: { gte: startOfMonth } },
  });
  if (count >= limit) {
    throw Errors.quota(
      limit === 0
        ? 'Your plan does not include AI eulogy generation. Upgrade to use it.'
        : `Your plan allows up to ${limit} AI eulogy generation${limit === 1 ? '' : 's'} per month. Upgrade for more, or try again next month.`,
    );
  }
}

async function recordEulogyGeneration(ownerId: string): Promise<void> {
  await prisma.eulogyGeneration.create({ data: { ownerId } });
}

export async function createEulogy(ownerId: string, input: GenerateEulogyInput) {
  await assertEulogyQuota(ownerId);

  const result = await generateEulogy({
    deceasedName: input.deceasedName,
    relationship: input.relationship,
    promptAnswers: input.promptAnswers,
    tone: input.tone,
  });
  await recordEulogyGeneration(ownerId);

  return prisma.eulogy.create({
    data: {
      ownerId,
      pageId: input.pageId,
      deceasedName: input.deceasedName,
      promptAnswers: input.promptAnswers as Prisma.InputJsonValue,      draftText: result.text,
      provider: result.provider,
      model: result.model,
      language: 'en',
      version: 1,
    },
  });
}

export async function listEulogies(ownerId: string) {
  return prisma.eulogy.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
}

export async function getEulogy(ownerId: string, eulogyId: string) {
  const e = await prisma.eulogy.findFirst({ where: { id: eulogyId, ownerId } });
  if (!e) throw Errors.notFound('Eulogy not found');
  return e;
}

/** Manual edit by the user; bumps the version so prior drafts are traceable. */
export async function reviseEulogy(ownerId: string, eulogyId: string, draftText: string) {
  const existing = await getEulogy(ownerId, eulogyId);
  return prisma.eulogy.update({
    where: { id: existing.id },
    data: { draftText, version: { increment: 1 } },
  });
}

/** Regenerate from the original prompt answers, producing a new version. */
export async function regenerateEulogy(ownerId: string, eulogyId: string) {
  const existing = await getEulogy(ownerId, eulogyId);
  await assertEulogyQuota(ownerId);
  const result = await generateEulogy({
    deceasedName: existing.deceasedName ?? 'the deceased', // older rows predate this column
    promptAnswers: existing.promptAnswers as Record<string, unknown>,
  });
  await recordEulogyGeneration(ownerId);
  return prisma.eulogy.update({
    where: { id: existing.id },
    data: { draftText: result.text, provider: result.provider, model: result.model, version: { increment: 1 } },
  });
}

export async function deleteEulogy(ownerId: string, eulogyId: string) {
  const existing = await getEulogy(ownerId, eulogyId);
  await prisma.eulogy.delete({ where: { id: existing.id } });
}

/**
 * GET /:eulogyId/pdf — stream a formatted PDF of the draft. Owner-only,
 * fully synchronous (pdfkit rendering is fast and in-process, no queue).
 * Mirrors vault.service.ts#downloadWrittenPdf's shape.
 */
export async function downloadEulogyPdf(ownerId: string, eulogyId: string) {
  const eulogy = await getEulogy(ownerId, eulogyId);
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { fullName: true },
  });

  const pdf = renderEulogyPdf({
    title: eulogy.deceasedName ?? 'Eulogy',
    bodyText: eulogy.draftText,
    createdAt: eulogy.createdAt,
    author: owner?.fullName ?? null,
  });

  const slug = (eulogy.deceasedName ?? 'eulogy')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'eulogy';

  return { filename: `${slug}.pdf`, pdf };
}
