import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogWriter } from '../../src/db/log-writer.js';
import type { WriterKind } from '../../src/db/log-writer.js';
import { createLogsRepository } from '../../src/db/logs-repository.js';
import type { LogsRepository } from '../../src/db/logs-repository.js';
import type { AggregateBucket } from '../../src/db/logs-repository.js';
import type { LogRecord } from '../../src/domain/log.js';
import type { BucketSize, GroupBy, LogFilters } from '../../src/domain/query.js';

const BASE = Date.parse('2026-07-20T14:00:00.000Z');
const MINUTE = 60_000;
const SERVICES = ['checkout', 'auth', 'search'];
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

// Deterministic spread across minutes, services and levels so the two paths have something
// non-trivial to disagree about.
function sample(count: number): LogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    timestampMs: BASE + (index % 180) * MINUTE + (index % 37) * 1000,
    level: LEVELS[index % LEVELS.length] ?? 'info',
    service: SERVICES[index % SERVICES.length] ?? 'checkout',
    message: `entry ${String(index)}`,
    attributes: { region: index % 2 === 0 ? 'eu-west' : 'us-east' },
  }));
}

describe('rollup agrees with the base table', () => {
  let pool: Pool;
  let logs: LogsRepository;

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(config.database);
    await runMigrations(pool, createLogger('error'));
    logs = createLogsRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM logs');
    await pool.query('DELETE FROM log_rollup_1m');
  });

  // Forcing a filter the rollup cannot serve makes the same request read the base table, so the
  // two results can be compared directly.
  async function viaBaseTable(
    base: LogFilters,
    bucket: BucketSize,
    groupBy?: GroupBy,
  ): Promise<AggregateBucket[]> {
    const rows = await pool.query<{ start: string; group: string | null; count: string }>(
      `SELECT to_char(date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start,
              ${groupBy === undefined ? 'NULL::text' : groupBy === 'level' ? 'level::text' : 'service'} AS "group",
              count(*)::text AS count
         FROM logs
        WHERE ts >= $2::timestamptz AND ts < $3::timestamptz
        GROUP BY 1, 2
        ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      [
        { '1m': '1 minute', '5m': '5 minutes', '1h': '1 hour', '1d': '1 day' }[bucket],
        new Date(base.sinceMs ?? 0).toISOString(),
        new Date(base.untilMs ?? 0).toISOString(),
      ],
    );

    return rows.rows.map((row) => ({
      start: row.start,
      group: row.group,
      count: Number(row.count),
    }));
  }

  describe.each<WriterKind>(['binary', 'text', 'insert'])('written by the %s writer', (kind) => {
    it.each<[BucketSize, GroupBy | undefined]>([
      ['1m', undefined],
      ['5m', undefined],
      ['1h', 'service'],
      ['1d', 'level'],
      ['1h', undefined],
    ])('matches for bucket %s grouped by %s', async (bucket, groupBy) => {
      const writer = await createLogWriter(pool, kind);
      await writer.write(sample(900));

      const range = filters({ sinceMs: BASE, untilMs: BASE + 180 * MINUTE });
      const fromRollup = await logs.aggregate({
        filters: range,
        bucket,
        ...(groupBy === undefined ? {} : { groupBy }),
      });
      const fromBase = await viaBaseTable(range, bucket, groupBy);

      expect(fromRollup).toEqual(fromBase);
      expect(fromRollup.reduce((total, row) => total + row.count, 0)).toBe(900);
    });
  });

  it('keeps counting correctly across several separate writes', async () => {
    const writer = await createLogWriter(pool, 'binary');
    await writer.write(sample(100));
    await writer.write(sample(100));
    await writer.write(sample(100));

    const buckets = await logs.aggregate({
      filters: filters({ sinceMs: BASE, untilMs: BASE + 180 * MINUTE }),
      bucket: '1h',
    });

    expect(buckets.reduce((total, row) => total + row.count, 0)).toBe(300);
  });

  it('falls back to the base table when an attribute filter is present', async () => {
    const writer = await createLogWriter(pool, 'binary');
    await writer.write(sample(120));

    const buckets = await logs.aggregate({
      filters: filters({
        sinceMs: BASE,
        untilMs: BASE + 180 * MINUTE,
        attributes: [{ key: 'region', value: 'eu-west' }],
      }),
      bucket: '1d',
    });

    expect(buckets[0]?.count).toBe(60);
  });

  // The rollup only holds whole minutes, so a range with partial minutes at either end must
  // still come back exact.
  it.each<[string, number, number]>([
    ['start mid-minute', 30_000, 180 * MINUTE],
    ['end mid-minute', 0, 180 * MINUTE + 17_000],
    ['both ends mid-minute', 21_000, 90 * MINUTE + 43_000],
    ['inside a single minute', 10_000, 50_000],
  ])('counts a range with a %s exactly', async (_name, fromOffset, toOffset) => {
    const writer = await createLogWriter(pool, 'binary');
    await writer.write(sample(600));

    const buckets = await logs.aggregate({
      filters: filters({ sinceMs: BASE + fromOffset, untilMs: BASE + toOffset }),
      bucket: '1d',
    });
    const exact = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM logs
        WHERE ts >= $1::timestamptz AND ts < $2::timestamptz`,
      [new Date(BASE + fromOffset).toISOString(), new Date(BASE + toOffset).toISOString()],
    );

    const total = buckets.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(Number(exact.rows[0]?.count));
    expect(total).toBeGreaterThan(0);
  });

  it('filters the rollup by service and level', async () => {
    const writer = await createLogWriter(pool, 'binary');
    await writer.write(sample(300));

    const byService = await logs.aggregate({
      filters: filters({ sinceMs: BASE, untilMs: BASE + 180 * MINUTE, service: 'auth' }),
      bucket: '1d',
    });
    const expected = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM logs WHERE service = 'auth'",
    );

    expect(byService[0]?.count).toBe(Number(expected.rows[0]?.count));
  });
});
