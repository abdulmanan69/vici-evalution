/**
 * Outgoing links (HRMS, CRM) per company: what is saved from the web and how
 * it is resolved against the environment. Pure functions only (no database),
 * so the rules are unit-tested in resolve.test.ts.
 *
 * Saved under companies.settings.links:
 *   links.hrms = { url, apiKeyEnc, keyLast4, webhookSecretEnc, enabled, updatedAt, updatedBy }
 *   links.crm  = { url, apiKeyEnc, keyLast4, enabled, updatedAt, updatedBy }
 * Keys and secrets are AES-256-GCM encrypted (lib/crypto.ts) and never sent
 * to a browser.
 *
 * Resolution, per company and per link:
 *   1. a link saved from the web and enabled  → that link ('web')
 *   2. a link saved from the web and disabled → nothing ('off'): the link is
 *      switched off for this company; the environment is NOT used instead
 *   3. no link saved from the web             → the environment exactly as
 *      before ('env'), or nothing ('none') when it does not cover the company
 *
 * The HRMS webhook secret is checked the same way, with one addition: an
 * enabled web link without its own webhook secret uses the environment's
 * secret for the company (HRMS_WEBHOOK_SECRET(S)), as before.
 */
import { hrmsEnvLink, hrmsEnvWebhookSecret } from '../hrms/client.js';
import { crmEnvLink } from '../crm/client.js';

export type LinkKind = 'hrms' | 'crm';
export type LinkSource = 'web' | 'env' | 'off' | 'none';

export interface StoredHrmsLink {
  url: string;
  apiKeyEnc: string | null;
  keyLast4: string | null;
  webhookSecretEnc: string | null;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface StoredCrmLink {
  url: string;
  apiKeyEnc: string | null;
  keyLast4: string | null;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface StoredLinks {
  hrms?: StoredHrmsLink;
  crm?: StoredCrmLink;
}

export interface ResolvedLink {
  source: LinkSource;
  url: string | null;
  apiKey: string | null;
  /** set when a web link cannot be used (e.g. its key cannot be decrypted) */
  error?: string;
}

export interface ResolvedHrmsLink extends ResolvedLink {
  webhookSecret: string | null;
}

export const DEFAULT_URLS: Record<LinkKind, string> = {
  hrms: 'https://hr.vertexpakistan.com',
  crm: 'https://crm.vertexpakistan.com',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The links saved in companies.settings (anything malformed is ignored). */
export function readStoredLinks(settings: unknown): StoredLinks {
  const links = (settings as { links?: unknown } | null)?.links;
  return parseStoredLinks(links);
}

export function parseStoredLinks(links: unknown): StoredLinks {
  const out: StoredLinks = {};
  if (!links || typeof links !== 'object') return out;
  const l = links as Record<string, Record<string, unknown> | undefined>;
  const h = l.hrms;
  if (h && typeof h === 'object' && str(h.url)) {
    out.hrms = {
      url: str(h.url)!,
      apiKeyEnc: str(h.apiKeyEnc),
      keyLast4: str(h.keyLast4),
      webhookSecretEnc: str(h.webhookSecretEnc),
      enabled: h.enabled !== false,
      updatedAt: str(h.updatedAt) ?? undefined,
      updatedBy: str(h.updatedBy),
    };
  }
  const c = l.crm;
  if (c && typeof c === 'object' && str(c.url)) {
    out.crm = {
      url: str(c.url)!,
      apiKeyEnc: str(c.apiKeyEnc),
      keyLast4: str(c.keyLast4),
      enabled: c.enabled !== false,
      updatedAt: str(c.updatedAt) ?? undefined,
      updatedBy: str(c.updatedBy),
    };
  }
  return out;
}

type Decrypt = (enc: string) => string;

function tryDecrypt(enc: string | null, decrypt: Decrypt): { value: string | null; failed: boolean } {
  if (!enc) return { value: null, failed: false };
  try {
    return { value: decrypt(enc), failed: false };
  } catch {
    return { value: null, failed: true };
  }
}

const UNREADABLE = 'The saved key cannot be read (was APP_ENCRYPTION_KEY changed?). Enter it again.';

/** Which HRMS URL, key and webhook secret a company uses. */
export function resolveHrmsLink(stored: StoredHrmsLink | undefined | null, slug: string, decrypt: Decrypt, env: NodeJS.ProcessEnv = process.env): ResolvedHrmsLink {
  if (stored) {
    if (!stored.enabled) return { source: 'off', url: stored.url, apiKey: null, webhookSecret: null };
    const key = tryDecrypt(stored.apiKeyEnc, decrypt);
    const secret = tryDecrypt(stored.webhookSecretEnc, decrypt);
    const webhookSecret = secret.value ?? (secret.failed ? null : hrmsEnvWebhookSecret(slug, env));
    if (key.failed || secret.failed) return { source: 'web', url: stored.url, apiKey: key.value, webhookSecret, error: UNREADABLE };
    if (!key.value) return { source: 'web', url: stored.url, apiKey: null, webhookSecret, error: 'No API key saved' };
    return { source: 'web', url: stored.url, apiKey: key.value, webhookSecret };
  }
  const e = hrmsEnvLink(slug, env);
  const webhookSecret = hrmsEnvWebhookSecret(slug, env);
  if (e) return { source: 'env', url: e.url, apiKey: e.apiKey, webhookSecret };
  return { source: 'none', url: env.HRMS_URL?.trim() || null, apiKey: null, webhookSecret };
}

/** Which CRM URL and key a company uses. */
export function resolveCrmLink(stored: StoredCrmLink | undefined | null, decrypt: Decrypt, env: NodeJS.ProcessEnv = process.env): ResolvedLink {
  if (stored) {
    if (!stored.enabled) return { source: 'off', url: stored.url, apiKey: null };
    const key = tryDecrypt(stored.apiKeyEnc, decrypt);
    if (key.failed) return { source: 'web', url: stored.url, apiKey: null, error: UNREADABLE };
    if (!key.value) return { source: 'web', url: stored.url, apiKey: null, error: 'No API key saved' };
    return { source: 'web', url: stored.url, apiKey: key.value };
  }
  const e = crmEnvLink(env);
  if (e) return { source: 'env', url: e.url, apiKey: e.apiKey };
  return { source: 'none', url: env.CRM_URL?.trim() || null, apiKey: null };
}

/** A usable link: has a URL and a key and nothing wrong with it. */
export const usable = (r: ResolvedLink): r is ResolvedLink & { url: string; apiKey: string } => !r.error && !!r.url && !!r.apiKey && (r.source === 'web' || r.source === 'env');

/**
 * Checks and tidies a link URL typed by an admin. https only; super admins may
 * also use http://localhost (or 127.0.0.1, ::1) for testing. Company admins
 * may not point at this server's own network. Returns the base URL without a
 * trailing slash and without the API path (".../api/v1" or ".../api/ext/v1"),
 * since the clients add those.
 */
export function normalizeLinkUrl(input: string, opts: { superAdmin: boolean; isInternalHost: (h: string) => boolean }): { ok: true; url: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter the address, e.g. https://hr.vertexpakistan.com' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid address' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:') {
    if (!(opts.superAdmin && loopback)) return { ok: false, error: 'The address must start with https://' };
  } else if (u.protocol !== 'https:') {
    return { ok: false, error: 'The address must start with https://' };
  }
  if (u.username || u.password) return { ok: false, error: 'Leave user names and passwords out of the address; use the API key field' };
  if (u.search || u.hash) return { ok: false, error: 'Leave ?… and #… out of the address' };
  if (!opts.superAdmin && opts.isInternalHost(host)) return { ok: false, error: 'The address must be a public one' };
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api\/(ext\/)?v1$/i, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

/** Same server (scheme, host and port)? Used to require the key again when a link is pointed elsewhere. */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export const last4 = (key: string): string => key.slice(-4);
