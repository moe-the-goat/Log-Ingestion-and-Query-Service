import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogsRepository } from './db/logs-repository.js';
import { createServer } from './http/server.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database);

  let ready = false;
  const logs = createLogsRepository(pool);
  const app = createServer({ config, readiness: { isReady: () => ready }, logs });

  // Listen before migrating so health checks get a 503 rather than a refused connection.
  await app.listen({ host: config.host, port: config.port });
  logger.info('listening', { host: config.host, port: config.port });

  await runMigrations(pool, logger);
  ready = true;
  logger.info('service ready');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    ready = false;
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      try {
        await app.close();
        await pool.end();
        process.exit(0);
      } catch (error) {
        logger.error('shutdown failed', { error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', message: 'startup failed', error: String(error) })}\n`,
  );
  process.exit(1);
});
