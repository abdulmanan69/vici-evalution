import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, dialerCloserLinks, dialerServers } from '../db/schema.js';
import { config } from '../config.js';

/**
 * Closer dialers: fronters on one dialer whose transfers are taken by
 * closers on another dialer — often another company's (one call centre's
 * fronters feeding a sister company's closers). The matcher then looks for
 * the closer leg on the linked dialers as well, and the transfer's company
 * may play that leg's recording (routes/recordings.ts). Nothing else of the
 * other company becomes visible.
 */

/** dialer id → the dialers its transfers may find their closer leg on */
export async function closerDialersOf(dialerIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (dialerIds.length === 0) return out;
  const rows = await db
    .select({ from: dialerCloserLinks.dialerServerId, to: dialerCloserLinks.closerDialerServerId })
    .from(dialerCloserLinks)
    .innerJoin(dialerServers, eq(dialerServers.id, dialerCloserLinks.closerDialerServerId))
    .where(and(inArray(dialerCloserLinks.dialerServerId, dialerIds), sql`${dialerServers.deletingAt} is null`));
  for (const r of rows) {
    if (!out.has(r.from)) out.set(r.from, []);
    out.get(r.from)!.push(r.to);
  }
  return out;
}

/** The links of these dialers with the closer dialers' names, for the admin page. */
export async function closerLinksForDisplay(
  dialerIds: string[],
): Promise<Map<string, { id: string; name: string; companyName: string }[]>> {
  const out = new Map<string, { id: string; name: string; companyName: string }[]>();
  if (dialerIds.length === 0) return out;
  const rows = await db
    .select({
      from: dialerCloserLinks.dialerServerId,
      id: dialerServers.id,
      name: dialerServers.name,
      companyName: companies.name,
    })
    .from(dialerCloserLinks)
    .innerJoin(dialerServers, eq(dialerServers.id, dialerCloserLinks.closerDialerServerId))
    .innerJoin(companies, eq(companies.id, dialerServers.companyId))
    .where(and(inArray(dialerCloserLinks.dialerServerId, dialerIds), sql`${dialerServers.deletingAt} is null`))
    .orderBy(dialerServers.name);
  for (const r of rows) {
    if (!out.has(r.from)) out.set(r.from, []);
    out.get(r.from)!.push({ id: r.id, name: r.name, companyName: r.companyName });
  }
  return out;
}

/**
 * Replaces a dialer's closer dialers. Transfers of this dialer that found no
 * closer leg (in the retention window, not resolved by hand) are handed back
 * to the matcher, so a new link applies to the calls already imported.
 */
export async function setCloserDialers(
  dialerServerId: string,
  closerIds: string[],
  userId: string | null,
): Promise<{ added: string[]; removed: string[]; rematching: number }> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ id: dialerCloserLinks.closerDialerServerId })
      .from(dialerCloserLinks)
      .where(eq(dialerCloserLinks.dialerServerId, dialerServerId));
    const before = new Set(current.map((r) => r.id));
    const after = new Set(closerIds);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    if (removed.length) {
      await tx
        .delete(dialerCloserLinks)
        .where(
          and(eq(dialerCloserLinks.dialerServerId, dialerServerId), inArray(dialerCloserLinks.closerDialerServerId, removed)),
        );
    }
    if (added.length) {
      await tx
        .insert(dialerCloserLinks)
        .values(added.map((id) => ({ dialerServerId, closerDialerServerId: id, createdBy: userId })))
        .onConflictDoNothing();
    }

    let rematching = 0;
    if (added.length) {
      const windowDays = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7;
      const res = await tx.execute(sql`
        update transfers set match_status = 'pending_match', updated_at = now()
         where dialer_server_id = ${dialerServerId} and kind = 'transfer' and not is_mock
           and match_status = 'unmatched' and closer_call_id is null
           and coalesce(match_method, '') <> 'manual'
           and xfer_time > now() - make_interval(days => ${windowDays})`);
      rematching = res.rowCount ?? 0;
    }
    return { added, removed, rematching };
  });
}

/**
 * Whether a call from another company is a closer or sale leg of one of
 * this company's transfers — the only way that company may play its audio.
 */
export async function isLegOfCompanyTransfer(companyId: string, callId: string): Promise<boolean> {
  const res = await db.execute(sql`
    select 1 from transfers t
     where t.company_id = ${companyId} and (t.closer_call_id = ${callId} or t.sale_call_id = ${callId})
     limit 1`);
  return (res.rowCount ?? 0) > 0;
}
