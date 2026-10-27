import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers } from '../db/schema.js';
import { toConnection } from '../vicidial/credentials.js';
import { getPooledDbClient } from '../vicidial/dbPool.js';
import { localToUtc } from '../vicidial/timezone.js';

type LeadFields = Record<string, unknown> | null;
export interface LeadResult {
  lead: LeadFields;
  leadCustom: LeadFields;
}

const EMPTY: LeadResult = { lead: null, leadCustom: null };
/** a lead barely changes while a reviewer works on it */
const TTL_MS = 60_000;
/** an unreachable dialer is not asked again for every page view */
const MISS_TTL_MS = 15_000;
const WAIT_MS = 3_000;
const MAX_ENTRIES = 1_000;

const cache = new Map<string, { at: number; ttl: number; value: LeadResult }>();
const inflight = new Map<string, Promise<LeadResult>>();

function remember(key: string, value: LeadResult, ttl: number): void {
  if (cache.size >= MAX_ENTRIES) {
    // Map keeps insertion order: drop the oldest tenth
    let n = Math.ceil(MAX_ENTRIES / 10);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--n <= 0) break;
    }
  }
  cache.set(key, { at: Date.now(), ttl, value });
}

async function fetchFromDialer(dialerServerId: string, leadId: number, listIdHint: number | null): Promise<LeadResult> {
  const [dialerRow] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
  if (!dialerRow || dialerRow.deletingAt) return EMPTY;
  const conn = toConnection(dialerRow);
  const client = getPooledDbClient(conn);
  if (!client) return EMPTY;
  const info = await client.fetchLead(leadId, listIdHint);
  if (!info) return EMPTY;
  // dialer-local timestamps become ISO (UTC) so the UI shows them in the
  // viewer's chosen zone
  const toIso = (rec: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      out[k] =
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) && !v.startsWith('0000')
          ? localToUtc(v, conn.timezone).toISOString()
          : v;
    }
    return out;
  };
  return {
    lead: {
      ...toIso(info.lead),
      list_name: info.list?.list_name ?? null,
      list_campaign: info.list?.campaign_id ?? null,
      list_active: info.list?.active ?? null,
    },
    leadCustom: info.custom ? toIso(info.custom) : null,
  };
}

/**
 * Lead details, read live from the dialer by primary key. Always optional: a
 * page never fails because of it and never waits more than 3 s. Results are
 * cached for a minute and concurrent requests for the same lead share one
 * dialer query; a lookup that outlives the wait still lands in the cache, so
 * the next view is instant.
 */
export async function loadLeadInfo(
  dialerServerId: string,
  leadId: number | null,
  listIdHint: number | null = null,
): Promise<LeadResult> {
  if (leadId == null) return EMPTY;
  const key = `${dialerServerId}:${leadId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchFromDialer(dialerServerId, leadId, listIdHint)
      .then((value) => {
        remember(key, value, value.lead ? TTL_MS : MISS_TTL_MS);
        return value;
      })
      .catch(() => {
        remember(key, EMPTY, MISS_TTL_MS);
        return EMPTY;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<LeadResult>((resolve) => {
    timer = setTimeout(() => resolve(EMPTY), WAIT_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test hook. */
export function clearLeadCache(): void {
  cache.clear();
  inflight.clear();
}
