import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogWriter } from '../src/db/log-writer.js';
import type { LogLevel, LogRecord } from '../src/domain/log.js';

const LEVELS: LogLevel[] = ['debug', 'info', 'info', 'info', 'warn', 'error'];
const SERVICES = ['checkout', 'auth', 'search', 'billing', 'inventory', 'notifications'];
const REGIONS = ['eu-west', 'us-east', 'ap-south'];
const MESSAGES = [
  'payment declined',
  'payment accepted',
  'token issued',
  'token expiring',
  'cache miss',
  'upstream timeout',
  'request completed',
  'inventory reserved',
];

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) throw new Error('empty pool');
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rows: { type: 'string', default: '1000000' },
      days: { type: 'string', default: '30' },
      batch: { type: 'string', default: '10000' },
    },
  });

  const rows = Number(values.rows);
  const days = Number(values.days);
  const batchSize = Number(values.batch);

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database);
  await runMigrations(pool, logger);

  const writer = await createLogWriter(pool, config.ingest.writer);

  const spanMs = days * 24 * 60 * 60 * 1000;
  const startMs = Date.now() - spanMs;
  const startedAt = Date.now();
  let written = 0;

  while (written < rows) {
    const size = Math.min(batchSize, rows - written);
    const records: LogRecord[] = new Array<LogRecord>(size);

    for (let index = 0; index < size; index += 1) {
      const position = written + index;
      // Spread evenly across the window so every partition and bucket gets realistic coverage.
      const timestampMs = startMs + Math.floor((position / rows) * spanMs);

      records[index] = {
        timestampMs,
        level: pick(LEVELS, position * 7),
        service: pick(SERVICES, position * 3),
        message: pick(MESSAGES, position * 5),
        attributes: {
          user_id: String(1000 + (position % 9973)),
          region: pick(REGIONS, position),
          retries: position % 4,
          cached: position % 2 === 0,
        },
      };
    }

    await writer.write(records);
    written += size;

    if (written % 100_000 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      logger.info('seeded', { rows: written, rowsPerSecond: Math.round(written / elapsed) });
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  logger.info('seed complete', {
    rows: written,
    seconds: Number(elapsed.toFixed(1)),
    rowsPerSecond: Math.round(written / elapsed),
  });

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
