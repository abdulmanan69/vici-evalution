import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { authenticate, SESSION_COOKIE } from '../auth/plugin.js';
import { login, logout } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { dialerServers, users } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { revokeUserSessions } from '../auth/session.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

/**
 * IP-wide ceiling on login attempts. The per-account limit (10 a minute) is
 * what stops password guessing; this stops one address from spraying many
 * accounts, yet leaves room for a whole shift logging in from one office IP.
 */
const LOGIN_IP_MAX_PER_MIN = 120;
const loginAttemptsByIp = new Map<string, { windowStart: number; n: number }>();
function tooManyLoginsFromIp(ip: string): boolean {
  const now = Date.now();
  if (loginAttemptsByIp.size > 10_000) loginAttemptsByIp.clear();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart >= 60_000) {
    loginAttemptsByIp.set(ip, { windowStart: now, n: 1 });
    return false;
  }
  entry.n += 1;
  return entry.n > LOGIN_IP_MAX_PER_MIN;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          // per account and address — a call centre logs in from one office
          // IP, so an IP-only limit locked most of a shift out at once
          hook: 'preHandler',
          keyGenerator: (req) => {
            const email = (req.body as { email?: unknown } | undefined)?.email;
            return `login:${req.ip}:${typeof email === 'string' ? email.toLowerCase().trim().slice(0, 200) : ''}`;
          },
        },
      },
    },
    async (req, reply) => {
      if (tooManyLoginsFromIp(req.ip)) {
        return reply.status(429).send({ error: 'rate_limited', message: 'Too many sign-in attempts — wait a minute and try again' });
      }
      const body = loginSchema.safeParse(req.body);
      if (!body.success) throw new ValidationError('Email and password are required');
      const result = await login(
        body.data.email,
        body.data.password,
        req.ip,
        req.headers['user-agent'],
      );
      if (!result) {
        // Same message for unknown user / wrong password — no account enumeration.
        throw new UnauthorizedError('Invalid email or password');
      }
      reply.setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        // 'auto' marks the cookie Secure only when the request came in over
      // HTTPS (trustProxy reads X-Forwarded-Proto), so a login behind Coolify,
      // Caddy or plain HTTP all work; COOKIE_SECURE=true forces it on
      secure: config.COOKIE_SECURE ? true : 'auto',
        path: '/',
        expires: result.expiresAt,
      });
      await audit(req, {
        action: 'auth.login',
        entityType: 'user',
        entityId: result.auth.userId,
        companyId: result.auth.companyId,
      });
      return { user: result.auth };
    },
  );

  app.post('/logout', { preHandler: [authenticate] }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: [authenticate] }, async (req) => {
    // the dialer's zone — every date in the app is a dialer day, and the
    // UI can show times in it or in the viewer's own zone
    const [dialer] = await db
      .select({ timezone: dialerServers.timezone })
      .from(dialerServers)
      .where(req.auth.companyId ? eq(dialerServers.companyId, req.auth.companyId) : eq(dialerServers.active, true))
      .orderBy(desc(dialerServers.active))
      .limit(1);
    return { user: { ...req.auth, dialerTimezone: dialer?.timezone ?? 'UTC' } };
  });

  app.post('/change-password', { preHandler: [authenticate] }, async (req, reply) => {
    const body = changePasswordSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError('New password must be at least 10 characters');
    const [row] = await db.select().from(users).where(eq(users.id, req.auth.userId));
    if (!row || !(await verifyPassword(body.data.currentPassword, row.passwordHash))) {
      throw new UnauthorizedError('Current password is incorrect');
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.data.newPassword), updatedAt: new Date() })
      .where(eq(users.id, req.auth.userId));
    await revokeUserSessions(req.auth.userId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await audit(req, { action: 'auth.change_password', entityType: 'user', entityId: req.auth.userId });
    return { ok: true, message: 'Password changed. Please sign in again.' };
  });
}
