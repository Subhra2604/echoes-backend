import { prisma } from '../../lib/prisma.js';

/**
 * Audit logging. [GAP §9] every privileged/moderation action records who did
 * what, to which entity, when, and WHY. This is the backbone of accountability
 * for the admin app and is also useful for GDPR/data-handling traceability.
 */
export interface AuditEntry {
  actorId?: string;
  action: string;       // e.g. "MEMORIAL_PAGE_DELETED", "ACTIVATION_OVERRIDDEN"
  targetType: string;   // e.g. "User", "MemorialPage", "TimeCapsule"
  targetId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      metadata: entry.metadata ?? undefined,
      ip: entry.ip,
    },
  });
}

export async function listAudit(filter: { targetType?: string; targetId?: string; actorId?: string } = {}) {
  return prisma.auditLog.findMany({
    where: {
      targetType: filter.targetType,
      targetId: filter.targetId,
      actorId: filter.actorId,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
