/**
 * WaveTech HRMS client for the VICIdial QA platform. No dependencies beyond
 * Node 20+ (fetch, crypto). Copy this folder to server/src/integrations/hrms.
 *
 * One HRMS API key belongs to one HRMS company. Which key a VICIdial QA
 * company uses comes from the environment (see hrmsFor below).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HrmsEmployee {
  sipId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: 'active' | 'pending' | 'inactive';
  active: boolean;
  employmentStatus: string;
  department: string | null;
  designation: string | null;
  dateOfJoining: string;
  leftAt: string | null;
  manager: { sipId: string; name: string | null; accounts: string[] } | null;
  /** present when the key has leave.view */
  onLeaveToday?: boolean;
  leaveToday?: { type: string; until: string } | null;
  upcomingLeave?: Array<{ from: string; to: string; days: number; type: string; status: 'approved' | 'pending' }>;
}

export type HrmsPerson = { externalId: string; context: string; found: false } | { externalId: string; context: string; found: true; employee: HrmsEmployee };

export interface HrmsEvent<T = Record<string, unknown>> {
  id: number;
  type: string;
  occurredAt: string;
  data: {
    entity: string;
    id: string | null;
    sipId: string | null;
    summary: string | null;
    record: T;
    /** the person's accounts in other systems, e.g. { vicidial: [{ externalId: 'agent1043', context: '' }] } */
    links?: Record<string, Array<{ externalId: string; context: string }>>;
  };
}

export interface MetricItem {
  /** the VICIdial agent user */
  externalId: string;
  /** only when HRMS links use dialer names to tell apart equal user names */
  context?: string;
  metric: string;
  /** 'YYYY-MM' or 'YYYY-MM-DD' */
  period: string;
  value: number;
  unit?: string;
  details?: Record<string, unknown>;
}

export interface SaleItem {
  /** the sale's id in the QA platform (transfer id); sending it again updates the sale */
  externalRef: string;
  /** 'YYYY-MM-DD', the day the sale counts for */
  saleDate: string;
  /** agent user who closed the sale */
  closer?: string;
  /** agent user whose transfer became the sale */
  fronter?: string;
  /** lead or customer number, shown in HRMS */
  reference?: string | null;
}

export interface SalesResult {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  voided: number;
  locked: number;
  unknown: string[];
}

export class HrmsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const SYSTEM = 'vicidial';

export class HrmsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new HrmsError(res.status, json?.error ?? 'request_error', json?.message ?? `HRMS answered ${res.status}`);
    return json as T;
  }

  /** The employees behind VICIdial agent users (up to 500 per call; larger lists are split). */
  async people(agentUsers: string[], context = ''): Promise<Map<string, HrmsPerson>> {
    const out = new Map<string, HrmsPerson>();
    const unique = [...new Set(agentUsers.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 500) {
      const ids = unique.slice(i, i + 500);
      const q = new URLSearchParams({ ids: ids.join(','), context });
      const r = await this.call<{ data: HrmsPerson[] }>('GET', `/connect/${SYSTEM}/people?${q}`);
      for (const p of r.data) out.set(p.externalId, p);
    }
    return out;
  }

  /** Every employee with their VICIdial accounts. */
  roster(status: 'active' | 'all' = 'active') {
    return this.call<{ data: Array<{ sipId: string; name: string; status: string; department: string | null; accounts: Array<{ externalId: string; context: string }> }> }>(
      'GET',
      `/connect/${SYSTEM}/roster?status=${status}`,
    );
  }

  /** Name matches for agents that are not linked yet (nothing is saved). */
  suggest(accounts: Array<{ externalId: string; fullName: string; context?: string }>) {
    return this.call<{ data: Array<{ externalId: string; linkedTo: string | null; suggestions: Array<{ sipId: string; name: string; score: number }> }> }>(
      'POST',
      `/connect/${SYSTEM}/suggest`,
      { accounts },
    );
  }

  /** Link agent users to employees (needs employees.manage on the key). */
  link(links: Array<{ sipId: string; externalId: string; context?: string }>) {
    return this.call<{ saved: number; failed: number }>('PUT', `/connect/${SYSTEM}/links`, { links });
  }

  /** Report figures per agent, e.g. monthly QA scores (needs metrics.write). Same agent + metric + period replaces the value. */
  async pushMetrics(items: MetricItem[]): Promise<{ saved: number; unknown: string[] }> {
    let saved = 0;
    const unknown: string[] = [];
    for (let i = 0; i < items.length; i += 1000) {
      const r = await this.call<{ saved: number; unknown: string[] }>('POST', `/connect/${SYSTEM}/metrics`, { items: items.slice(i, i + 1000) });
      saved += r.saved;
      unknown.push(...r.unknown);
    }
    return { saved, unknown };
  }

  /**
   * Report sales (needs sales.write). HRMS credits the closer and the fronter.
   * With a window, HRMS voids its sales from this dialer context in that date
   * range that are not in `items`, so undone sales stop counting.
   */
  pushSales(items: SaleItem[], window?: { from: string; to: string }, context = '') {
    return this.call<SalesResult>('POST', `/connect/${SYSTEM}/sales`, { context, window, items });
  }

  /** Changes since a cursor, for polling instead of a webhook. */
  events(after: number, types = 'employee.*,leave_application.*', limit = 200) {
    return this.call<{ data: HrmsEvent[]; next: number }>('GET', `/integrations/events?after=${after}&limit=${limit}&types=${encodeURIComponent(types)}`);
  }
}

/**
 * Checks an HRMS webhook: HMAC-SHA256 of "<timestamp>.<raw body>" with the
 * webhook secret, and a timestamp no older than 5 minutes.
 */
export function verifyHrmsWebhook(rawBody: string, headers: Record<string, unknown>, secret: string, toleranceSec = 300): boolean {
  const ts = String(headers['x-hrms-timestamp'] ?? '');
  const sig = String(headers['x-hrms-signature'] ?? '');
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Which HRMS key a QA company uses                                     */
/* ------------------------------------------------------------------ */

/**
 * Environment (no change to config.ts needed):
 *   HRMS_URL=https://hrms.example.com
 *   HRMS_API_KEY=hrms_…               one HRMS company for every QA company, or
 *   HRMS_API_KEYS=acme=hrms_…,beta=hrms_…   per QA company slug
 *   HRMS_WEBHOOK_SECRET=whsec_…        or HRMS_WEBHOOK_SECRETS=acme=whsec_…,beta=whsec_…
 */
function perCompany(list: string | undefined, single: string | undefined, slug: string): string | null {
  if (list) {
    for (const pair of list.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim());
      if (k === slug && v) return v;
    }
  }
  return single?.trim() || null;
}

const clients = new Map<string, HrmsClient>();

/** The HRMS client for a QA company, or null when HRMS is not set up for it. */
export function hrmsFor(companySlug: string): HrmsClient | null {
  const url = process.env.HRMS_URL?.trim();
  const key = perCompany(process.env.HRMS_API_KEYS, process.env.HRMS_API_KEY, companySlug);
  if (!url || !key) return null;
  const id = `${url}|${key}`;
  if (!clients.has(id)) clients.set(id, new HrmsClient(url, key));
  return clients.get(id)!;
}

export function hrmsWebhookSecret(companySlug: string): string | null {
  return perCompany(process.env.HRMS_WEBHOOK_SECRETS, process.env.HRMS_WEBHOOK_SECRET, companySlug);
}
