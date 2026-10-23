import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies } from '../db/schema.js';

/** Per-company QA behaviour, kept under companies.settings.qa. */
export interface QaSettings {
  /** minutes a reviewer may still change a completed evaluation; 0 = locked the moment it is completed */
  evaluationEditWindowMinutes: number;
}

export const DEFAULT_QA_SETTINGS: QaSettings = { evaluationEditWindowMinutes: 24 * 60 };

export async function getQaSettings(companyId: string): Promise<QaSettings> {
  const [row] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  const qa = ((row?.settings as { qa?: Partial<QaSettings> } | null)?.qa ?? {}) as Partial<QaSettings>;
  const minutes = Number(qa.evaluationEditWindowMinutes);
  return {
    evaluationEditWindowMinutes:
      Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : DEFAULT_QA_SETTINGS.evaluationEditWindowMinutes,
  };
}

export async function updateQaSettings(companyId: string, patch: Partial<QaSettings>): Promise<QaSettings> {
  const next = { ...(await getQaSettings(companyId)), ...patch };
  await db
    .update(companies)
    .set({
      // merge at the top level so other setting groups survive
      settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || ${JSON.stringify({ qa: next })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));
  return next;
}

/** When a completed evaluation locks; null while it is still a draft. */
export function editableUntil(completedAt: Date | null, settings: QaSettings): Date | null {
  if (!completedAt) return null;
  return new Date(completedAt.getTime() + settings.evaluationEditWindowMinutes * 60_000);
}
