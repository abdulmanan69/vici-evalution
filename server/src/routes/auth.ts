import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { authenticate, SESSION_COOKIE } from '../auth/plugin.js';
import { login, logout } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
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
        secure: config.COOKIE_SECURE,
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
    return { user: req.auth };
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
