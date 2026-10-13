import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { authenticate } from './auth/plugin.js';
import { authRoutes } from './routes/auth.js';
import { companyRoutes } from './routes/companies.js';
import { dialerRoutes } from './routes/dialers.js';
import { agentRoutes } from './routes/agents.js';
import { campaignRoutes } from './routes/campaigns.js';
import { dispositionRoutes } from './routes/dispositions.js';
import { queueRoutes } from './routes/queues.js';
import { recordingRoutes } from './routes/recordings.js';
import { qaFormRoutes } from './routes/qaForms.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { userRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';
import { syncRoutes } from './routes/sync.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { reportRoutes } from './routes/reports.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
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
    req.log.error({ err }, 'unhandled error');
    // Never leak internals to the client.
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/v1/auth' });

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
