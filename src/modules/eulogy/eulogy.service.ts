import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { generateEulogy } from './eulogy.providers.js';
import type { GenerateEulogyInput } from './eulogy.dto.js';

/**
 * Eulogy service. [GAP §5] "stored vs fresh" was not decided by the client — we
 * STORE each generated draft (the schema is versioned), which lets users edit,
 * revisit, and regenerate without paying for inference every view. Switching to
 * fresh-on-demand later only means skipping the persisted read.
 */

export async function createEulogy(ownerId: string, input: GenerateEulogyInput) {
  const result = await generateEulogy({
    deceasedName: input.deceasedName,
    relationship: input.relationship,
    promptAnswers: input.promptAnswers,
    tone: input.tone,
  });

  return prisma.eulogy.create({
    data: {
      ownerId,
      pageId: input.pageId,
      promptAnswers: input.promptAnswers,
      draftText: result.text,
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
  const result = await generateEulogy({
    deceasedName: 'the deceased',
    promptAnswers: existing.promptAnswers as Record<string, unknown>,
  });
  return prisma.eulogy.update({
    where: { id: existing.id },
    data: { draftText: result.text, provider: result.provider, model: result.model, version: { increment: 1 } },
  });
}

export async function deleteEulogy(ownerId: string, eulogyId: string) {
  const existing = await getEulogy(ownerId, eulogyId);
  await prisma.eulogy.delete({ where: { id: existing.id } });
}
