/**
 * Outgoing links per company, read from and saved to companies.settings.links
 * (rules in resolve.ts). Every place that talks to the HRMS or the CRM asks
 * here which URL and key to use.
 *
 * Cache: every company's saved links are read in one query and kept for 30 s
 * in each process. Saving a link clears this process's cache at once; the
 * worker's push jobs always read fresh, so a saved link is used by the very
 * next run (and "Push now").
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies } from '../../db/schema.js';
import { decryptSecret } from '../../lib/crypto.js';
import { hrmsClient, type HrmsClient } from '../hrms/client.js';
import { crmClientFor, type CrmClient } from '../crm/client.js';
import {
  parseStoredLinks,
  resolveCrmLink,
  resolveHrmsLink,
  usable,
  type LinkKind,
  type ResolvedHrmsLink,
  type ResolvedLink,
  type StoredCrmLink,
  type StoredHrmsLink,
  type StoredLinks,
} from './resolve.js';

export interface CompanyLinks {
  id: string;
  slug: string;
  name: string;
  status: string;
  links: StoredLinks;
}

interface Snapshot {
  at: number;
  byId: Map<string, CompanyLinks>;
  bySlug: Map<string, CompanyLinks>;
}

const TTL_MS = 30_000;
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

/** Drops this process's cached links (after a save). */
export function forgetLinkCache(): void {
  snapshot = null;
}

async function load(): Promise<Snapshot> {
  const rows = await db
    .select({ id: companies.id, slug: companies.slug, name: companies.name, status: companies.status, links: sql<unknown>`${companies.settings}->'links'` })
    .from(companies);
  const byId = new Map<string, CompanyLinks>();
  const bySlug = new Map<string, CompanyLinks>();
  for (const r of rows) {
    const c: CompanyLinks = { id: r.id, slug: r.slug, name: r.name, status: r.status, links: parseStoredLinks(r.links) };
    byId.set(c.id, c);
    bySlug.set(c.slug, c);
  }
  return { at: Date.now(), byId, bySlug };
}

/** Every company's saved links; `fresh` skips the cache (push jobs). */
export async function linkSnapshot(fresh = false): Promise<Snapshot> {
  if (!fresh && snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot;
  if (!loading) {
    loading = load()
      .then((s) => {
        snapshot = s;
        return s;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** The HRMS link a company uses (by slug). Unknown slugs get the environment, as before. */
export async function hrmsLinkFor(slug: string, fresh = false): Promise<ResolvedHrmsLink> {
  const s = await linkSnapshot(fresh);
  return resolveHrmsLink(s.bySlug.get(slug)?.links.hrms, slug, decryptSecret);
}

/** The HRMS client for a company, or null when it has no usable HRMS link. */
export async function hrmsForCompany(slug: string, fresh = false): Promise<HrmsClient | null> {
  const r = await hrmsLinkFor(slug, fresh);
  return usable(r) ? hrmsClient(r.url, r.apiKey) : null;
}

/** The secret HRMS signs this company's webhooks with, or null (webhooks are then refused). */
export async function hrmsWebhookSecretFor(slug: string): Promise<string | null> {
  return (await hrmsLinkFor(slug)).webhookSecret;
}

/** The CRM link a company uses. */
export async function crmLinkFor(companyId: string, fresh = false): Promise<ResolvedLink> {
  const s = await linkSnapshot(fresh);
  return resolveCrmLink(s.byId.get(companyId)?.links.crm, decryptSecret);
}

export function crmClientOf(r: ResolvedLink): CrmClient | null {
  return usable(r) ? crmClientFor(r.url, r.apiKey) : null;
}

/** Does any company have an enabled link of this kind saved from the web? */
export async function anyWebLink(kind: LinkKind, fresh = false): Promise<boolean> {
  const s = await linkSnapshot(fresh);
  for (const c of s.byId.values()) if (c.status === 'active' && c.links[kind]?.enabled) return true;
  return false;
}

/** Saves (or with null removes) one link of a company. Other settings are left alone. */
export async function saveLink(companyId: string, kind: 'hrms', value: StoredHrmsLink | null): Promise<void>;
export async function saveLink(companyId: string, kind: 'crm', value: StoredCrmLink | null): Promise<void>;
export async function saveLink(companyId: string, kind: LinkKind, value: StoredHrmsLink | StoredCrmLink | null): Promise<void> {
  const links = sql`coalesce(${companies.settings}->'links', '{}'::jsonb)`;
  const next = value === null ? sql`${links} - ${kind}::text` : sql`${links} || jsonb_build_object(${kind}::text, ${JSON.stringify(value)}::jsonb)`;
  await db
    .update(companies)
    .set({ settings: sql`jsonb_set(coalesce(${companies.settings}, '{}'::jsonb), '{links}', ${next})` })
    .where(eq(companies.id, companyId));
  forgetLinkCache();
}

/** companies.settings without the saved links, for anything sent to a browser or written to the audit log. */
export function withoutLinks<T extends { settings?: unknown }>(row: T): T {
  if (!row || !row.settings || typeof row.settings !== 'object' || !('links' in (row.settings as object))) return row;
  const { links, ...rest } = row.settings as Record<string, unknown>;
  void links;
  return { ...row, settings: rest };
}

export function hrmsClientOf(r: ResolvedLink): HrmsClient | null {
  return usable(r) ? hrmsClient(r.url, r.apiKey) : null;
}
