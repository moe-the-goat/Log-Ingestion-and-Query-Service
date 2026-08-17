import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogWriter } from '../../src/db/log-writer.js';
import { dropExpiredPartitions, ensurePartitions } from '../../src/db/partitions.js';
import type { LogRecord } from '../../src/domain/log.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const logger = createLogger('error');

function dayName(offsetDays: number): string {
  const dayMs = Date.now() - (Date.now() % DAY_MS) + offsetDays * DAY_MS;
  return `logs_${new Date(dayMs).toISOString().slice(0, 10).replace(/-/g, '_')}`;
}

function record(timestampMs: number, overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs,
    level: 'info',
    service: 'checkout',
    message: 'request completed',
    attributes: {},
    ...overrides,
  };
}

async function partitionNames(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT child.relname AS name
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'logs'
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

describe('partition maintenance', () => {
  let pool: Pool;

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(config.database);
    await runMigrations(pool, logger);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    for (const name of await partitionNames(pool)) {
      if (name !== 'logs_default') await pool.query(`DROP TABLE IF EXISTS ${name}`);
    }
    await pool.query('DELETE FROM logs');
    await pool.query('DELETE FROM log_rollup_1m');
  });

  it('covers the retention window and the lookahead window', async () => {
    const created = await ensurePartitions(pool, { aheadDays: 2, retentionDays: 30 }, logger);
    const names = await partitionNames(pool);

    expect(created).toBe(33);
    expect(names).toContain(dayName(-30));
    expect(names).toContain(dayName(-1));
    expect(names).toContain(dayName(0));
    expect(names).toContain(dayName(2));
    expect(names).not.toContain(dayName(3));
  });

  it('is safe to run repeatedly', async () => {
    await ensurePartitions(pool, { aheadDays: 2, retentionDays: 30 }, logger);
    const created = await ensurePartitions(pool, { aheadDays: 2, retentionDays: 30 }, logger);

    expect(created).toBe(0);
  });

  it('routes a row to the partition for its day', async () => {
    await ensurePartitions(pool, { aheadDays: 2, retentionDays: 30 }, logger);
    const writer = await createLogWriter(pool, 'binary');
    await writer.write([record(Date.now())]);

    const stored = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${dayName(0)}`,
    );

    expect(stored.rows[0]?.count).toBe('1');
  });

  it('adopts rows the default partition already holds', async () => {
    const writer = await createLogWriter(pool, 'binary');
    await writer.write([record(Date.now()), record(Date.now())]);

    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM logs_default',
    );
    expect(before.rows[0]?.count).toBe('2');

    await ensurePartitions(pool, { aheadDays: 1, retentionDays: 30 }, logger);

    const moved = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${dayName(0)}`,
    );
    const left = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM logs_default',
    );
    const total = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM logs');

    expect(moved.rows[0]?.count).toBe('2');
    expect(left.rows[0]?.count).toBe('0');
    expect(total.rows[0]?.count).toBe('2');
  });

  it('drops only partitions older than the retention window', async () => {
    await ensurePartitions(pool, { aheadDays: 1, retentionDays: 30 }, logger);
    const today = Date.now() - (Date.now() % DAY_MS);
    const old = `logs_${new Date(today - 40 * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '_')}`;
    await pool.query(
      `CREATE TABLE ${old} PARTITION OF logs
         FOR VALUES FROM ('${new Date(today - 40 * DAY_MS).toISOString()}')
                      TO ('${new Date(today - 39 * DAY_MS).toISOString()}')`,
    );

    const dropped = await dropExpiredPartitions(pool, { aheadDays: 1, retentionDays: 30 }, logger);
    const names = await partitionNames(pool);

    expect(dropped).toEqual([old]);
    expect(names).not.toContain(old);
    expect(names).toContain(dayName(0));
  });

  it('never drops the default partition', async () => {
    await ensurePartitions(pool, { aheadDays: 1, retentionDays: 1 }, logger);
    await dropExpiredPartitions(pool, { aheadDays: 1, retentionDays: 1 }, logger);

    expect(await partitionNames(pool)).toContain('logs_default');
  });

  it('keeps a partition whose day is exactly on the retention boundary', async () => {
    const today = Date.now() - (Date.now() % DAY_MS);
    const boundary = `logs_${new Date(today - 30 * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '_')}`;
    await pool.query(
      `CREATE TABLE ${boundary} PARTITION OF logs
         FOR VALUES FROM ('${new Date(today - 30 * DAY_MS).toISOString()}')
                      TO ('${new Date(today - 29 * DAY_MS).toISOString()}')`,
    );

    await dropExpiredPartitions(pool, { aheadDays: 1, retentionDays: 30 }, logger);

    expect(await partitionNames(pool)).toContain(boundary);
  });
});
