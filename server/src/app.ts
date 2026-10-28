import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { authenticate, SESSION_COOKIE } from './auth/plugin.js';
import { invalidateAuthCache } from './auth/session.js';
import { sha256 } from './lib/crypto.js';
import { authRoutes } from './routes/auth.js';
import { companyRoutes } from './routes/companies.js';
import { dialerRoutes } from './routes/dialers.js';
import { agentRoutes } from './routes/agents.js';
import { campaignRoutes } from './routes/campaigns.js';
import { dispositionRoutes } from './routes/dispositions.js';
import { queueRoutes } from './routes/queues.js';
import { recordingRoutes } from './routes/recordings.js';
import { qaFormRoutes } from './routes/qaForms.js';
import { qaTeamRoutes } from './routes/qaTeam.js';
import { qaSettingsRoutes } from './routes/qaSettings.js';
import { taskRoutes } from './routes/tasks.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { userRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';
import { syncRoutes } from './routes/sync.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { reportRoutes } from './routes/reports.js';
import { opsRoutes } from './routes/ops.js';
import { opsLogStream } from './lib/opsLog.js';
import { recordRequest } from './lib/requestStats.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      // stdout as before; warnings and errors also go to the diagnostics log
      stream: opsLogStream(),
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });
  // A call centre's reviewers usually share one office IP, so limits are per
  // signed-in session — one IP-wide budget throttled the whole team at busy
  // times (live recording polls, audio seeks and page loads add up). Requests
  // without a session stay limited per IP.
  await app.register(rateLimit, {
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const token = req.cookies?.[SESSION_COOKIE];
      return token ? `s:${sha256(token).slice(0, 32)}` : `ip:${req.ip}`;
    },
    max: (_req, key) => (key.startsWith('s:') ? 1200 : 600),
  });
  // Session lookups are cached for a few seconds; any change made through
  // the API (users, roles, assignments, forms …) drops the cache so access
  // changes apply on the very next request.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400) {
      invalidateAuthCache();
    }
  });
  // request timing for remote diagnostics (lib/requestStats.ts)
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz') return;
    recordRequest({
      method: req.method,
      route: req.routeOptions?.url ?? '(no route)',
      path: req.url.split('?')[0],
      status: reply.statusCode,
      ms: reply.elapsedTime,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Invalid input',
        details: err.flatten().fieldErrors,
      });
    }
    const fe = err as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof fe.statusCode === 'number' && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({
        error: typeof fe.code === 'string' ? fe.code : 'request_error',
        message: typeof fe.message === 'string' ? fe.message : 'Request error',
      });
    }
    req.log.error({ err, method: req.method, url: req.url }, 'unhandled error');
    // Never leak internals to the client.
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  // remote diagnostics: its own token instead of a session; absent unless OPS_TOKEN is set
  await app.register(opsRoutes, { prefix: '/api/v1/ops' });

  await app.register(
    async (api) => {
      api.addHook('preHandler', authenticate);
      await api.register(companyRoutes, { prefix: '/companies' });
      await api.register(dialerRoutes, { prefix: '/dialers' });
      await api.register(agentRoutes, { prefix: '/agents' });
      await api.register(campaignRoutes, { prefix: '/campaigns' });
      await api.register(dispositionRoutes, { prefix: '/dispositions' });
      await api.register(queueRoutes, { prefix: '/queues' });
      await api.register(recordingRoutes, { prefix: '/recordings' });
      await api.register(qaFormRoutes, { prefix: '/qa/forms' });
      await api.register(qaTeamRoutes, { prefix: '/qa/team' });
      await api.register(qaSettingsRoutes, { prefix: '/qa/settings' });
      await api.register(taskRoutes, { prefix: '/qa/tasks' });
      await api.register(evaluationRoutes, { prefix: '/evaluations' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(auditRoutes, { prefix: '/audit-logs' });
      await api.register(syncRoutes, { prefix: '/sync' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
      await api.register(reportRoutes, { prefix: '/reports' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
