import { config } from './config.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { closeDb } from './db/client.js';
import { captureConsole, captureCrashes, flushOpsLog, recordBoot, setOpsSource } from './lib/opsLog.js';
import { buildInfo } from './lib/runtime.js';
import { setupOpsReader } from './services/opsReader.js';
import { opsToken } from './routes/ops.js';

async function main(): Promise<void> {
  // warnings, errors and crashes reach the diagnostics log (routes/ops.ts)
  setOpsSource('api');
  captureConsole({ info: false });
  captureCrashes();

  await runMigrations();
  await seed();

  if (config.OPS_TOKEN.trim() && !opsToken()) {
    console.warn('OPS_TOKEN is shorter than 32 characters — remote diagnostics stay off');
  }
  await setupOpsReader(opsToken()).catch((err: Error) => console.warn('diagnostics: read-only SQL setup failed:', err.message));

  const app = await buildApp();
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  recordBoot('api', { ...buildInfo(), diagnostics: !!opsToken() });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeDb();
    await flushOpsLog(1000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('Fatal startup error:', err);
  await flushOpsLog(2000);
  process.exit(1);
});
