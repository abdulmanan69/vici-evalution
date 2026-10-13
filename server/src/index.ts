import { config } from './config.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { closeDb } from './db/client.js';

async function main(): Promise<void> {
  await runMigrations();
  await seed();

  const app = await buildApp();
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
