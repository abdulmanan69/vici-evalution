import type { FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  companyId?: string | null;
}

/** Writes an audit row for a sensitive action. Failures are logged, never fatal. */
export async function audit(req: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      companyId: entry.companyId !== undefined ? entry.companyId : (req.auth?.companyId ?? null),
      userId: req.auth?.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: req.ip,
    });
  } catch (err) {
    req.log.error({ err }, 'audit write failed');
  }
}
