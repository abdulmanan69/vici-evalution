/**
 * Setting up the outgoing links (HRMS, CRM) of one company from the web.
 * Registered inside connectionRoutes (/api/v1/connections), so it needs
 * admin.users like the rest of the Connections page: company admins manage
 * their own company, super admins any company.
 *
 *   GET    /links/company?companyId=     both links: where they come from, URL, key (last 4 only), last runs
 *   PUT    /links/hrms                   { companyId?, url, apiKey?, webhookSecret?, enabled }
 *   PUT    /links/crm                    { companyId?, url, apiKey?, enabled }
 *   DELETE /links/:kind?companyId=       forget the web link (the environment applies again)
 *   POST   /links/:kind/test             { companyId?, url?, apiKey? } try the link now
 *   POST   /links/:kind/push             { companyId? } queue this link's jobs for the company now
 *
 * Keys and secrets are encrypted at rest and never returned; the audit log
 * records what changed, never the values.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { companyScope, isSuperAdmin } from '../../auth/plugin.js';
import { audit } from '../../lib/audit.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { hrmsEnvLink } from '../hrms/client.js';
import { forgetHrmsCache } from '../hrms/sync.js';
import { crmEnvLink } from '../crm/client.js';
import { isInternalHost } from '../connections/catalog.js';
import { jobStates, type JobState } from '../connections/jobStatus.js';
import { companyJobName, enqueueLinkPush, envSetsUp, jobSwitchedOn, LINK_JOBS } from './jobs.js';
import {
  DEFAULT_URLS,
  last4,
  normalizeLinkUrl,
  resolveCrmLink,
  resolveHrmsLink,
  sameOrigin,
  type LinkKind,
  type StoredCrmLink,
  type StoredHrmsLink,
} from './resolve.js';
import { linkSnapshot, saveLink, type CompanyLinks } from './store.js';

const kindSchema = z.enum(['hrms', 'crm']);
const secretSchema = z.string().trim().min(8, 'The key looks too short').max(500);

/** The company a request is about: company admins their own, super admins the one named (or their current one). */
async function targetCompany(req: FastifyRequest, requested?: string): Promise<CompanyLinks> {
  const id = companyScope(req, requested) ?? req.auth.companyId ?? undefined;
  if (!id) throw new ValidationError('Choose a company');
  const c = (await linkSnapshot(true)).byId.get(id);
  if (!c || c.status === 'deleting') throw new NotFoundError('Company not found');
  return c;
}

function checkedUrl(req: FastifyRequest, url: string): string {
  const r = normalizeLinkUrl(url, { superAdmin: isSuperAdmin(req.auth), isInternalHost });
  if (!r.ok) throw new ValidationError(r.error);
  return r.url;
}

interface LastRun {
  job: string;
  switchedOn: boolean;
  /** this company's part of the last run (scheduled or "Push now", whichever is newer) */
  run: { ok: boolean; finishedAt: string; manual: boolean; result: unknown; error?: string | null; lastOkAt?: string | null } | null;
}

/** This company's entry in a job result that lists companies, or the whole result otherwise. */
function partFor(result: unknown, slug: string, envCovered: boolean): unknown {
  const r = (result as { sent?: unknown })?.sent ?? result;
  if (Array.isArray(r)) {
    const own = r.find((x: { company?: string }) => x?.company === slug);
    if (own) return own;
    // CRM: companies on the environment's key are pushed together
    const shared = envCovered ? r.find((x: { company?: string }) => x?.company === 'server settings') : undefined;
    return shared ?? null;
  }
  return r ?? null;
}

function lastRuns(kind: LinkKind, c: CompanyLinks, jobs: Record<string, JobState>, envCovered: boolean): LastRun[] {
  return LINK_JOBS[kind].map((job) => {
    const scheduled = jobs[job];
    const manual = jobs[companyJobName(job, c.id)];
    const pick = scheduled && manual ? (manual.finishedAt > scheduled.finishedAt ? manual : scheduled) : (manual ?? scheduled);
    if (!pick) return { job, switchedOn: jobSwitchedOn(job), run: null };
    const isManual = pick === manual;
    const part = pick.ok ? partFor(pick.result, c.slug, envCovered) : null;
    const partError = part && typeof part === 'object' && 'error' in part ? String((part as { error: unknown }).error) : null;
    return {
      job,
      switchedOn: jobSwitchedOn(job),
      run: {
        ok: pick.ok && !partError,
        finishedAt: pick.finishedAt,
        manual: isManual,
        result: part,
        error: pick.ok ? partError : (pick.error ?? null),
        lastOkAt: pick.lastOkAt ?? null,
      },
    };
  });
}

/** What the browser may see of a company's links: never a key or secret. */
export function linkView(c: CompanyLinks, jobs: Record<string, JobState>) {
  const h = c.links.hrms;
  const hr = resolveHrmsLink(h, c.slug, decryptSecret);
  const hrEnv = hrmsEnvLink(c.slug);
  const cr = c.links.crm;
  const crr = resolveCrmLink(cr, decryptSecret);
  const crEnv = crmEnvLink();
  return {
    company: { id: c.id, name: c.name, slug: c.slug },
    hrms: {
      source: hr.source,
      url: hr.url,
      defaultUrl: DEFAULT_URLS.hrms,
      enabled: h ? h.enabled : null,
      hasKey: h ? !!h.apiKeyEnc : !!hrEnv,
      keyLast4: h ? h.keyLast4 : hrEnv ? last4(hrEnv.apiKey) : null,
      hasWebhookSecret: h ? !!h.webhookSecretEnc : false,
      webhookSecretFromEnv: !!hr.webhookSecret && !(h && h.webhookSecretEnc),
      webhookPath: `/api/v1/hrms/webhook/${c.slug}`,
      error: hr.error ?? null,
      updatedAt: h?.updatedAt ?? null,
      env: { url: process.env.HRMS_URL?.trim() || null, hasKey: !!hrEnv },
      jobs: lastRuns('hrms', c, jobs, false),
    },
    crm: {
      source: crr.source,
      url: crr.url,
      defaultUrl: DEFAULT_URLS.crm,
      enabled: cr ? cr.enabled : null,
      hasKey: cr ? !!cr.apiKeyEnc : !!crEnv,
      keyLast4: cr ? cr.keyLast4 : crEnv ? last4(crEnv.apiKey) : null,
      error: crr.error ?? null,
      updatedAt: cr?.updatedAt ?? null,
      env: { url: crEnv?.url ?? (process.env.CRM_URL?.trim() || null), hasKey: !!crEnv, setUp: envSetsUp('crm') },
      jobs: lastRuns('crm', c, jobs, crr.source === 'env'),
    },
  };
}

/** What changed, for the audit log (no keys or secrets). */
const auditView = (l: StoredHrmsLink | StoredCrmLink | undefined | null) =>
  l ? { url: l.url, enabled: l.enabled, hasKey: !!l.apiKeyEnc, ...('webhookSecretEnc' in l ? { hasWebhookSecret: !!l.webhookSecretEnc } : {}) } : null;

/* ------------------------------------------------------------- testing */

export interface TestResult {
  ok: boolean;
  status: number | null;
  message: string;
  /** CRM: the key's name and scopes; HRMS: the attendance settings */
  details?: Record<string, unknown>;
}

async function probe(url: string, apiKey: string): Promise<{ status: number; json: unknown } | { status: null; error: string }> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { status: null, error: e.name === 'TimeoutError' ? 'no answer within 10 seconds' : (e.cause?.code ?? e.message ?? 'network error') };
  }
}

const serverMessage = (json: unknown) => {
  const m = (json as { message?: unknown })?.message;
  return typeof m === 'string' ? ` (${m.slice(0, 200)})` : '';
};

export async function testHrms(url: string, apiKey: string): Promise<TestResult> {
  const r = await probe(`${url}/api/v1/connect/vicidial/attendance/settings`, apiKey);
  if (r.status === null) return { ok: false, status: null, message: `Could not reach the HR system: ${r.error}` };
  if (r.status === 200) {
    const j = (r.json ?? {}) as { timeZone?: string; dayStartsAt?: string };
    return {
      ok: true,
      status: 200,
      message: `Connected. The HR system's shift day starts at ${j.dayStartsAt ?? '?'} (${j.timeZone ?? '?'}).`,
      details: { timeZone: j.timeZone ?? null, dayStartsAt: j.dayStartsAt ?? null },
    };
  }
  if (r.status === 401) return { ok: false, status: 401, message: `The HR system did not accept this key (401). Check the key${serverMessage(r.json)}.` };
  if (r.status === 403) return { ok: false, status: 403, message: `The key works but lacks the attendance.write permission (403)${serverMessage(r.json)}.` };
  if (r.status === 404) return { ok: false, status: 404, message: 'Not found (404). Check the address: it should be the HR system itself, e.g. https://hr.vertexpakistan.com.' };
  if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, message: `The address redirects (${r.status}). Use the final address, with https://.` };
  return { ok: false, status: r.status, message: `The HR system answered ${r.status}${serverMessage(r.json)}.` };
}

export async function testCrm(url: string, apiKey: string): Promise<TestResult> {
  const r = await probe(`${url}/api/ext/v1/me`, apiKey);
  if (r.status === null) return { ok: false, status: null, message: `Could not reach the CRM: ${r.error}` };
  if (r.status === 200) {
    const j = (r.json ?? {}) as Record<string, unknown>;
    const inner = (j.data ?? j.key ?? j) as Record<string, unknown>;
    const name = typeof inner.name === 'string' ? inner.name : typeof j.name === 'string' ? j.name : null;
    const scopesRaw = inner.scopes ?? j.scopes;
    const scopes = Array.isArray(scopesRaw) ? scopesRaw.filter((s): s is string => typeof s === 'string') : null;
    const missing = scopes && !scopes.includes('metrics.write') && !scopes.includes('*');
    return {
      ok: !missing,
      status: 200,
      message: missing
        ? `Connected as ${name ?? 'this key'}, but the key lacks the metrics.write scope, so scores cannot be sent.`
        : `Connected as ${name ?? 'this key'}.`,
      details: { name, scopes },
    };
  }
  if (r.status === 401) return { ok: false, status: 401, message: `The CRM did not accept this key (401). Check the key${serverMessage(r.json)}.` };
  if (r.status === 403) return { ok: false, status: 403, message: `The CRM refused this key (403)${serverMessage(r.json)}.` };
  if (r.status === 404) return { ok: false, status: 404, message: 'Not found (404). Check the address: it should be the CRM itself, e.g. https://crm.vertexpakistan.com.' };
  if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, message: `The address redirects (${r.status}). Use the final address, with https://.` };
  return { ok: false, status: r.status, message: `The CRM answered ${r.status}${serverMessage(r.json)}.` };
}

/* --------------------------------------------------------------- routes */

export async function linkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/links/company', async (req) => {
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const c = await targetCompany(req, q.companyId);
    return linkView(c, await jobStates());
  });

  app.put('/links/hrms', async (req) => {
    const body = z
      .object({
        companyId: z.string().uuid().optional(),
        url: z.string().max(500),
        apiKey: secretSchema.optional().or(z.literal('')),
        webhookSecret: secretSchema.optional().or(z.literal('')),
        /** true drops the saved webhook secret (the environment's applies again, if any) */
        clearWebhookSecret: z.boolean().optional(),
        enabled: z.boolean(),
      })
      .parse(req.body);
    const c = await targetCompany(req, body.companyId);
    const url = checkedUrl(req, body.url);
    const before = c.links.hrms;
    if (!body.apiKey && !before?.apiKeyEnc) throw new ValidationError('Enter the API key');
    // never send a saved key to a different server without typing it again
    if (!body.apiKey && before && !sameOrigin(before.url, url)) throw new ValidationError('The address changed: enter the API key again');
    const next: StoredHrmsLink = {
      url,
      apiKeyEnc: body.apiKey ? encryptSecret(body.apiKey) : before!.apiKeyEnc,
      keyLast4: body.apiKey ? last4(body.apiKey) : (before?.keyLast4 ?? null),
      webhookSecretEnc: body.webhookSecret ? encryptSecret(body.webhookSecret) : body.clearWebhookSecret ? null : (before?.webhookSecretEnc ?? null),
      enabled: body.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: req.auth.userId,
    };
    await saveLink(c.id, 'hrms', next);
    forgetHrmsCache(c.id);
    await audit(req, {
      action: 'connections.link_save',
      entityType: 'company',
      entityId: c.id,
      before: { link: 'hrms', ...auditView(before) },
      after: { link: 'hrms', ...auditView(next), keyChanged: !!body.apiKey, webhookSecretChanged: !!body.webhookSecret || !!body.clearWebhookSecret },
      companyId: c.id,
    });
    return linkView((await linkSnapshot(true)).byId.get(c.id)!, await jobStates());
  });

  app.put('/links/crm', async (req) => {
    const body = z
      .object({
        companyId: z.string().uuid().optional(),
        url: z.string().max(500),
        apiKey: secretSchema.optional().or(z.literal('')),
        enabled: z.boolean(),
      })
      .parse(req.body);
    const c = await targetCompany(req, body.companyId);
    const url = checkedUrl(req, body.url);
    const before = c.links.crm;
    if (!body.apiKey && !before?.apiKeyEnc) throw new ValidationError('Enter the API key');
    if (!body.apiKey && before && !sameOrigin(before.url, url)) throw new ValidationError('The address changed: enter the API key again');
    const next: StoredCrmLink = {
      url,
      apiKeyEnc: body.apiKey ? encryptSecret(body.apiKey) : before!.apiKeyEnc,
      keyLast4: body.apiKey ? last4(body.apiKey) : (before?.keyLast4 ?? null),
      enabled: body.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: req.auth.userId,
    };
    await saveLink(c.id, 'crm', next);
    await audit(req, {
      action: 'connections.link_save',
      entityType: 'company',
      entityId: c.id,
      before: { link: 'crm', ...auditView(before) },
      after: { link: 'crm', ...auditView(next), keyChanged: !!body.apiKey },
      companyId: c.id,
    });
    return linkView((await linkSnapshot(true)).byId.get(c.id)!, await jobStates());
  });

  app.delete('/links/:kind', async (req) => {
    const { kind } = z.object({ kind: kindSchema }).parse(req.params);
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const c = await targetCompany(req, q.companyId);
    const before = c.links[kind];
    if (before) {
      if (kind === 'hrms') await saveLink(c.id, 'hrms', null);
      else await saveLink(c.id, 'crm', null);
      if (kind === 'hrms') forgetHrmsCache(c.id);
      await audit(req, { action: 'connections.link_delete', entityType: 'company', entityId: c.id, before: { link: kind, ...auditView(before) }, companyId: c.id });
    }
    return linkView((await linkSnapshot(true)).byId.get(c.id)!, await jobStates());
  });

  app.post('/links/:kind/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { kind } = z.object({ kind: kindSchema }).parse(req.params);
    const body = z
      .object({ companyId: z.string().uuid().optional(), url: z.string().max(500).optional(), apiKey: z.string().trim().max(500).optional() })
      .parse(req.body ?? {});
    const c = await targetCompany(req, body.companyId);
    const resolved = kind === 'hrms' ? resolveHrmsLink(c.links.hrms, c.slug, decryptSecret) : resolveCrmLink(c.links.crm, decryptSecret);
    const url = body.url ? checkedUrl(req, body.url) : resolved.url;
    if (!url) throw new ValidationError('Enter the address');
    let key = body.apiKey || null;
    if (!key) {
      // the key in use (saved here, or from server settings), only for the server it belongs to
      const stored = c.links[kind];
      let saved: string | null = null;
      if (stored?.apiKeyEnc) {
        try {
          saved = decryptSecret(stored.apiKeyEnc);
        } catch {
          saved = null;
        }
        if (saved && sameOrigin(stored.url, url)) key = saved;
      } else {
        const env = kind === 'hrms' ? hrmsEnvLink(c.slug) : crmEnvLink();
        if (env && sameOrigin(env.url, url)) key = env.apiKey;
      }
    }
    if (!key) throw new ValidationError('Enter the API key to test');
    const result = kind === 'hrms' ? await testHrms(url, key) : await testCrm(url, key);
    req.log.info({ kind, companyId: c.id, status: result.status, ok: result.ok }, 'link test');
    return { result };
  });

  app.post('/links/:kind/push', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { kind } = z.object({ kind: kindSchema }).parse(req.params);
    const body = z.object({ companyId: z.string().uuid().optional() }).parse(req.body ?? {});
    const c = await targetCompany(req, body.companyId);
    const r = kind === 'hrms' ? resolveHrmsLink(c.links.hrms, c.slug, decryptSecret) : resolveCrmLink(c.links.crm, decryptSecret);
    if (r.source === 'off') throw new ValidationError('This link is switched off for the company');
    if (r.source === 'none') throw new ValidationError('This link is not set up for the company');
    const queued = await enqueueLinkPush(kind, c.id);
    await audit(req, { action: 'connections.link_push', entityType: 'company', entityId: c.id, after: { link: kind, jobs: queued }, companyId: c.id });
    return { queued, at: new Date().toISOString() };
  });
}
