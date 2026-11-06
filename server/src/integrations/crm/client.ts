/**
 * CRM client (crm.vertexpakistan.com machine API) for the VICIdial QA
 * platform. No dependencies beyond Node 20+ (fetch).
 *
 * Environment:
 *   CRM_URL=https://crm.example.com
 *   CRM_API_KEY=…            one key; the CRM may limit it to some companies
 *
 * Empty CRM_URL or CRM_API_KEY = off. A company can also have its own CRM
 * link saved from the web (Admin → Connections → Outgoing links); that one
 * wins for the company, the environment covers every other company.
 */

export interface CrmMetricItem {
  /** the VICIdial agent user, upper-case */
  agent: string;
  metric: string;
  /** 'YYYY-MM' */
  period: string;
  value: number;
  unit?: string;
  details?: Record<string, unknown>;
}

export interface CrmMetricsResult {
  received: number;
  saved: number;
  unknown: string[];
}

export class CrmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The name this platform reports under. */
export const CRM_SOURCE = 'qa.vertexpakistan.com';

export class CrmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/ext/v1${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: { error?: string; message?: string } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) throw new CrmError(res.status, json?.error ?? 'request_error', json?.message ?? `CRM answered ${res.status}`);
    return json as T;
  }

  /** Figures per agent and month. Same agent + metric + period replaces the value. At most 5,000 items per call; larger lists are split. */
  async pushMetrics(items: CrmMetricItem[]): Promise<CrmMetricsResult> {
    const total: CrmMetricsResult = { received: 0, saved: 0, unknown: [] };
    for (let i = 0; i < items.length; i += 5000) {
      const r = await this.call<CrmMetricsResult>('POST', '/metrics', { source: CRM_SOURCE, items: items.slice(i, i + 5000) });
      total.received += Number(r?.received ?? 0);
      total.saved += Number(r?.saved ?? 0);
      total.unknown.push(...(r?.unknown ?? []));
    }
    total.unknown = [...new Set(total.unknown)];
    return total;
  }
}

const clients = new Map<string, CrmClient>();

/** One client per URL + key, reused across calls. */
export function crmClientFor(url: string, apiKey: string): CrmClient {
  const id = `${url}|${apiKey}`;
  if (!clients.has(id)) clients.set(id, new CrmClient(url, apiKey));
  return clients.get(id)!;
}

/**
 * The CRM URL and key from the environment, or null when CRM_URL / CRM_API_KEY
 * are not set. One key for every company without a link of its own saved from
 * the web (see integrations/links/store.ts).
 */
export function crmEnvLink(env: NodeJS.ProcessEnv = process.env): { url: string; apiKey: string } | null {
  const url = env.CRM_URL?.trim();
  const key = env.CRM_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, apiKey: key };
}

/** The environment's CRM client, or null when CRM_URL / CRM_API_KEY are not set. */
export function crmClient(): CrmClient | null {
  const env = crmEnvLink();
  return env ? crmClientFor(env.url, env.apiKey) : null;
}
