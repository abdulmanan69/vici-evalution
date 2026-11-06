/**
 * API key authentication for the machine API (/api/v1/ext). Separate from
 * signed-in sessions: a key is `Authorization: Bearer qa_…`, carries scopes,
 * and is bound to one company or, made by a super admin, to all of them.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies, integrationKeys } from '../../db/schema.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { hashApiKey, looksLikeApiKey, type Scope } from './catalog.js';

export interface ExtKey {
  id: string;
  name: string;
  prefix: string;
  companyId: string | null;
  companySlug: string | null;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    extKey?: ExtKey;
  }
}

// keys looked up in the last few seconds; a revoke is seen within CACHE_MS
const cache = new Map<string, { at: number; key: ExtKey | null }>();
const CACHE_MS = 10_000;
// last_used_at is written at most once a minute per key
const lastTouch = new Map<string, number>();
const TOUCH_MS = 60_000;

export function forgetKeyCache(): void {
  cache.clear();
}

async function lookup(hash: string): Promise<ExtKey | null> {
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
  const [row] = await db
    .select({ k: integrationKeys, slug: companies.slug, status: companies.status })
    .from(integrationKeys)
    .leftJoin(companies, eq(integrationKeys.companyId, companies.id))
    .where(eq(integrationKeys.keyHash, hash));
  const ok = row && !row.k.revokedAt && (row.k.companyId === null || row.status === 'active');
  const key: ExtKey | null = ok
    ? { id: row.k.id, name: row.k.name, prefix: row.k.keyPrefix, companyId: row.k.companyId, companySlug: row.slug ?? null, scopes: row.k.scopes }
    : null;
  if (cache.size > 1000) cache.clear();
  cache.set(hash, { at: Date.now(), key });
  return key;
}

/** preHandler: resolves the Bearer API key into request.extKey. */
export const authenticateKey: preHandlerHookHandler = async (req) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !looksLikeApiKey(token)) throw new UnauthorizedError('Send an API key: Authorization: Bearer qa_…');
  const key = await lookup(hashApiKey(token));
  if (!key) throw new UnauthorizedError('API key is unknown or revoked');
  req.extKey = key;
  const last = lastTouch.get(key.id) ?? 0;
  if (Date.now() - last > TOUCH_MS) {
    lastTouch.set(key.id, Date.now());
    void db
      .update(integrationKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(integrationKeys.id, key.id))
      .catch((err: unknown) => req.log.warn({ err }, 'api key last_used_at update failed'));
  }
};

/** preHandler factory: the key must carry this scope. */
export function requireScope(scope: Scope): preHandlerHookHandler {
  return async (req) => {
    if (!req.extKey) throw new UnauthorizedError();
    if (!req.extKey.scopes.includes(scope)) throw new ForbiddenError(`This key lacks the scope ${scope}`);
  };
}

export function hasScope(req: FastifyRequest, scope: Scope): boolean {
  return !!req.extKey?.scopes.includes(scope);
}

/**
 * The company ids a request may read: the key's own company, or, for an
 * all-company key, every active company or the one named by ?company=slug.
 */
export async function keyCompanies(req: FastifyRequest, slug?: string): Promise<Array<{ id: string; slug: string }>> {
  const key = req.extKey!;
  if (key.companyId) {
    if (slug && slug !== key.companySlug) throw new ForbiddenError('This key belongs to another company');
    return [{ id: key.companyId, slug: key.companySlug ?? '' }];
  }
  const rows = await db.select({ id: companies.id, slug: companies.slug, status: companies.status }).from(companies);
  return rows.filter((c) => c.status === 'active' && (!slug || c.slug === slug)).map(({ id, slug: s }) => ({ id, slug: s }));
}
