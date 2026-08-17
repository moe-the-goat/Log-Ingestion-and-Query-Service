import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogsRepository } from '../../src/db/logs-repository.js';
import type { LogsRepository } from '../../src/db/logs-repository.js';
import type { Attributes, LogLevel } from '../../src/domain/log.js';
import type { LogFilters } from '../../src/domain/query.js';

const BASE = Date.parse('2026-07-20T14:00:00Z');
const MINUTE = 60_000;

function record(
  offsetMinutes: number,
  level: LogLevel,
  service: string,
  message: string,
  attributes: Attributes = {},
) {
  return { timestampMs: BASE + offsetMinutes * MINUTE, level, service, message, attributes };
}

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

describe('log queries', () => {
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
    await logs.insert([
      record(0, 'error', 'checkout', 'payment declined', { region: 'eu-west', retries: 3 }),
      record(1, 'info', 'checkout', 'payment accepted', { region: 'us-east', retries: 0 }),
      record(2, 'warn', 'auth', 'token expiring SOON', { cached: true }),
      record(65, 'error', 'auth', 'token rejected', { region: 'eu-west' }),
      record(70, 'debug', 'checkout', 'cache warm', {}),
    ]);
  });

  it('returns newest first', async () => {
    const result = await logs.search({ filters: filters(), limit: 100 });

    expect(result.logs.map((log) => log.message)).toEqual([
      'cache warm',
      'token rejected',
      'token expiring SOON',
      'payment accepted',
      'payment declined',
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('formats the timestamp the way the API returns it', async () => {
    const result = await logs.search({ filters: filters({ service: 'auth' }), limit: 1 });

    expect(result.logs[0]?.timestamp).toBe('2026-07-20T15:05:00.000Z');
  });

  it('filters by service and by level', async () => {
    const byService = await logs.search({ filters: filters({ service: 'auth' }), limit: 100 });
    const byLevel = await logs.search({ filters: filters({ level: 'error' }), limit: 100 });

    expect(byService.logs).toHaveLength(2);
    expect(byLevel.logs.map((log) => log.message)).toEqual(['token rejected', 'payment declined']);
  });

  it('treats since as inclusive and until as exclusive', async () => {
    const result = await logs.search({
      filters: filters({ sinceMs: BASE, untilMs: BASE + 2 * MINUTE }),
      limit: 100,
    });

    expect(result.logs.map((log) => log.message)).toEqual(['payment accepted', 'payment declined']);
  });

  it('returns nothing for an empty range', async () => {
    const result = await logs.search({
      filters: filters({ sinceMs: BASE - MINUTE, untilMs: BASE - MINUTE }),
      limit: 100,
    });

    expect(result.logs).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('matches an attribute stored as text', async () => {
    const result = await logs.search({
      filters: filters({ attributes: [{ key: 'region', value: 'eu-west' }] }),
      limit: 100,
    });

    expect(result.logs).toHaveLength(2);
  });

  it('matches a numeric attribute given as a string', async () => {
    const result = await logs.search({
      filters: filters({ attributes: [{ key: 'retries', value: '3' }] }),
      limit: 100,
    });

    expect(result.logs.map((log) => log.message)).toEqual(['payment declined']);
  });

  it('matches a boolean attribute given as a string', async () => {
    const result = await logs.search({
      filters: filters({ attributes: [{ key: 'cached', value: 'true' }] }),
      limit: 100,
    });

    expect(result.logs.map((log) => log.message)).toEqual(['token expiring SOON']);
  });

  it('combines attribute filters with and', async () => {
    const result = await logs.search({
      filters: filters({
        attributes: [
          { key: 'region', value: 'eu-west' },
          { key: 'retries', value: '3' },
        ],
      }),
      limit: 100,
    });

    expect(result.logs).toHaveLength(1);
  });

  it('matches the message case-insensitively', async () => {
    const result = await logs.search({ filters: filters({ q: 'soon' }), limit: 100 });

    expect(result.logs.map((log) => log.message)).toEqual(['token expiring SOON']);
  });

  it('treats wildcards in the search term literally', async () => {
    await logs.insert([record(3, 'info', 'checkout', '100% complete')]);

    const literal = await logs.search({ filters: filters({ q: '100%' }), limit: 100 });
    const wildcard = await logs.search({ filters: filters({ q: 'z%z' }), limit: 100 });

    expect(literal.logs).toHaveLength(1);
    expect(wildcard.logs).toHaveLength(0);
  });

  it('returns preserved attribute types', async () => {
    const result = await logs.search({ filters: filters({ q: 'declined' }), limit: 1 });

    expect(result.logs[0]?.attributes).toEqual({ region: 'eu-west', retries: 3 });
  });

  describe('pagination', () => {
    it('walks every row exactly once and ends with a null cursor', async () => {
      const seen: string[] = [];
      let cursor = undefined;

      for (let page = 0; page < 10; page += 1) {
        const result = await logs.search({ filters: filters(), limit: 2, cursor });
        seen.push(...result.logs.map((log) => log.message));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      expect(seen).toEqual([
        'cache warm',
        'token rejected',
        'token expiring SOON',
        'payment accepted',
        'payment declined',
      ]);
    });

    it('stays deterministic when timestamps tie', async () => {
      await pool.query('DELETE FROM logs');
      await pool.query('DELETE FROM log_rollup_1m');
      await logs.insert([
        record(0, 'info', 'checkout', 'tied a'),
        record(0, 'info', 'checkout', 'tied b'),
        record(0, 'info', 'checkout', 'tied c'),
        record(0, 'info', 'checkout', 'tied d'),
      ]);

      const full = await logs.search({ filters: filters(), limit: 100 });
      const paged: string[] = [];
      let cursor = undefined;

      for (let page = 0; page < 10; page += 1) {
        const result = await logs.search({ filters: filters(), limit: 1, cursor });
        paged.push(...result.logs.map((log) => log.message));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      expect(paged).toEqual(full.logs.map((log) => log.message));
      expect(new Set(paged).size).toBe(4);
    });

    it('reports no cursor when the last page is exactly full', async () => {
      const result = await logs.search({ filters: filters({ service: 'auth' }), limit: 2 });

      expect(result.logs).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('aggregate', () => {
    it('counts into wall-clock aligned buckets', async () => {
      const buckets = await logs.aggregate({
        filters: filters({ sinceMs: BASE, untilMs: BASE + 120 * MINUTE }),
        bucket: '1h',
      });

      expect(buckets).toEqual([
        { start: '2026-07-20T14:00:00Z', group: null, count: 3 },
        { start: '2026-07-20T15:00:00Z', group: null, count: 2 },
      ]);
    });

    it('groups by service', async () => {
      const buckets = await logs.aggregate({
        filters: filters({ sinceMs: BASE, untilMs: BASE + 120 * MINUTE }),
        bucket: '1h',
        groupBy: 'service',
      });

      expect(buckets).toEqual([
        { start: '2026-07-20T14:00:00Z', group: 'auth', count: 1 },
        { start: '2026-07-20T14:00:00Z', group: 'checkout', count: 2 },
        { start: '2026-07-20T15:00:00Z', group: 'auth', count: 1 },
        { start: '2026-07-20T15:00:00Z', group: 'checkout', count: 1 },
      ]);
    });

    it('groups by level', async () => {
      const buckets = await logs.aggregate({
        filters: filters({ sinceMs: BASE, untilMs: BASE + MINUTE }),
        bucket: '1m',
        groupBy: 'level',
      });

      expect(buckets).toEqual([{ start: '2026-07-20T14:00:00Z', group: 'error', count: 1 }]);
    });

    it('applies the same filters as a search', async () => {
      const buckets = await logs.aggregate({
        filters: filters({
          sinceMs: BASE,
          untilMs: BASE + 120 * MINUTE,
          attributes: [{ key: 'region', value: 'eu-west' }],
        }),
        bucket: '1d',
      });

      expect(buckets).toEqual([{ start: '2026-07-20T00:00:00Z', group: null, count: 2 }]);
    });

    it('omits empty buckets', async () => {
      const buckets = await logs.aggregate({
        filters: filters({ sinceMs: BASE, untilMs: BASE + 120 * MINUTE }),
        bucket: '1m',
      });

      expect(buckets).toHaveLength(5);
    });
  });
});
