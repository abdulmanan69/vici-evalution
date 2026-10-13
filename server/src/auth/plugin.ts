import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { hasPermission, type Permission } from './permissions.js';
import { resolveSession, type AuthContext } from './session.js';

export const SESSION_COOKIE = 'qa_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

/** preHandler: resolves the session cookie (or Bearer token) into request.auth. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = cookieToken ?? bearer;
  if (!token) throw new UnauthorizedError('Not signed in');
  const auth = await resolveSession(token);
  if (!auth) throw new UnauthorizedError('Session expired or invalid');
  req.auth = auth;
}

/** preHandler factory: requires a specific permission (always server-side). */
export function requirePermission(perm: Permission): preHandlerHookHandler {
  return async (req) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!hasPermission(req.auth.permissions, perm)) {
      throw new ForbiddenError(`Missing permission: ${perm}`);
    }
  };
}

export function isSuperAdmin(auth: AuthContext): boolean {
  return auth.companyId === null && auth.permissions.includes('*');
}

/**
 * Company-level data isolation. Returns the company id every query MUST be
 * filtered by, or undefined when a super admin intentionally queries across
 * companies. A company-bound user asking for another company is rejected.
 */
export function companyScope(req: FastifyRequest, requestedCompanyId?: string): string | undefined {
  const auth = req.auth;
  if (isSuperAdmin(auth)) {
    return requestedCompanyId || undefined;
  }
  if (!auth.companyId) throw new ForbiddenError('User is not attached to a company');
  if (requestedCompanyId && requestedCompanyId !== auth.companyId) {
    throw new ForbiddenError('Cross-company access denied');
  }
  return auth.companyId;
}

/** Like companyScope but always returns a concrete company id. */
export function requiredCompanyScope(req: FastifyRequest, requestedCompanyId?: string): string {
  const scope = companyScope(req, requestedCompanyId);
  if (!scope) throw new ForbiddenError('companyId is required for this operation');
  return scope;
}
