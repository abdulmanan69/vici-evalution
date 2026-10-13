import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default('postgres://vici_qa:vici_qa@localhost:5432/vici_qa'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'APP_ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .default('0000000000000000000000000000000000000000000000000000000000000000'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SUPERADMIN_EMAIL: z.string().email().default('admin@example.com'),
  SUPERADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
  SEED_DEMO: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SYNC_POLL_SECONDS: z.coerce.number().default(60),
  SYNC_LOOKBACK_MINUTES: z.coerce.number().default(15),
  SYNC_HISTORICAL_DAYS: z.coerce.number().default(30),
  RECORDING_RETRY_MINUTES: z.coerce.number().default(10),
  MATCH_AUTO_THRESHOLD: z.coerce.number().default(70),
  MATCH_FLAG_THRESHOLD: z.coerce.number().default(40),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

if (
  config.NODE_ENV === 'production' &&
  config.APP_ENCRYPTION_KEY === '0000000000000000000000000000000000000000000000000000000000000000'
) {
  // eslint-disable-next-line no-console
  console.error('FATAL: APP_ENCRYPTION_KEY must be set to a real key in production.');
  process.exit(1);
}
