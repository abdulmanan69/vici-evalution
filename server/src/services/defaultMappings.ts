import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, dialerServers, dispositionMappings } from '../db/schema.js';

/**
 * What a stock VICIdial disposition means, for a company that has not mapped
 * anything yet. Without at least the XFER and SALE meanings no transfer or
 * sale is ever recognised and a new company's queues stay empty however much
 * data is imported. NI ("not interested") means nothing for the queues.
 */
export const DEFAULT_MAPPINGS: Array<{ code: string; meaning: 'transfer' | 'sale' | 'callback' | 'other' }> = [
  { code: 'XFER', meaning: 'transfer' },
  { code: 'SALE', meaning: 'sale' },
  { code: 'CALLBK', meaning: 'callback' },
  { code: 'NI', meaning: 'other' },
];

/**
 * Gives a company the default meanings when it has none at all, and asks its
 * dialers to re-read the retention window with them. Returns true when it
 * added them. Companies that mapped anything themselves are left alone.
 */
export async function ensureDefaultMappings(companyId: string, createdBy: string | null = null): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(dispositionMappings)
    .where(eq(dispositionMappings.companyId, companyId));
  if (n > 0) return false;
  await db.insert(dispositionMappings).values(
    DEFAULT_MAPPINGS.map((m) => ({ companyId, dispositionCode: m.code, meaning: m.meaning, createdBy })),
  );
  await requestBackfill(companyId);
  return true;
}

/** Every company without a single mapping gets the defaults (worker start). */
export async function ensureDefaultMappingsEverywhere(): Promise<number> {
  const rows = await db.select({ id: companies.id, status: companies.status }).from(companies);
  let added = 0;
  for (const c of rows) {
    if (c.status === 'deleting') continue;
    if (await ensureDefaultMappings(c.id)) added += 1;
  }
  return added;
}

/**
 * Transfers and sales are derived from disposition meanings, so when those
 * change the company's dialers re-read the retention window with the new
 * meanings (the worker picks this up on its next tick).
 */
export async function requestBackfill(companyId: string, dialerIds?: string[]): Promise<void> {
  await db
    .update(dialerServers)
    .set({ backfilledAt: null })
    .where(
      and(
        eq(dialerServers.companyId, companyId),
        dialerIds && dialerIds.length ? inArray(dialerServers.id, dialerIds) : undefined,
      ),
    );
}
