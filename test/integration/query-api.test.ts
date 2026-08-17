import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogsRepository } from '../../src/db/logs-repository.js';
import type { LogsRepository } from '../../src/db/logs-repository.js';
import { registerLogsQueryRoutes } from '../../src/http/routes/logs-query.js';

const BASE = Date.parse('2026-07-20T14:00:00Z');
const MINUTE = 60_000;

interface LogsBody {
  logs: { id: string; timestamp: string; message: string; attributes: Record<string, unknown> }[];
  next_cursor: string | null;
}

interface BucketsBody {
  buckets: { start: string; group: string | null; count: number }[];
}

describe('GET /logs and GET /logs/aggregate', () => {
  let pool: Pool;
  let logs: LogsRepository;
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(config.database);
    await runMigrations(pool, createLogger('error'));
    logs = createLogsRepository(pool);

    app = Fastify({ logger: false });
    registerLogsQueryRoutes(app, logs);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM logs');
    await pool.query('DELETE FROM log_rollup_1m');
    await logs.insert([
      {
        timestampMs: BASE,
        level: 'error',
        service: 'checkout',
        message: 'payment declined',
        attributes: { region: 'eu-west', retries: 3 },
      },
      {
        timestampMs: BASE + MINUTE,
        level: 'info',
        service: 'auth',
        message: 'token issued',
        attributes: {},
      },
      {
        timestampMs: BASE + 2 * MINUTE,
        level: 'warn',
        service: 'auth',
        message: 'token expiring',
        attributes: {},
      },
    ]);
  });

  it('returns the documented response shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/logs?service=checkout' });
    const body = response.json<LogsBody>();

    expect(response.statusCode).toBe(200);
    expect(body.next_cursor).toBeNull();
    expect(body.logs).toHaveLength(1);
    expect(Object.keys(body.logs[0] ?? {}).sort()).toEqual([
      'attributes',
      'id',
      'level',
      'message',
      'service',
      'timestamp',
    ]);
    expect(body.logs[0]?.attributes).toEqual({ region: 'eu-west', retries: 3 });
  });

  it('pages through results with an opaque cursor', async () => {
    const first = await app.inject({ method: 'GET', url: '/logs?limit=2' });
    const firstBody = first.json<LogsBody>();

    expect(firstBody.logs).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/logs?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
    });
    const secondBody = second.json<LogsBody>();

    expect(secondBody.logs.map((log) => log.message)).toEqual(['payment declined']);
    expect(secondBody.next_cursor).toBeNull();
  });

  it('filters by attribute through the query string', async () => {
    const response = await app.inject({ method: 'GET', url: '/logs?attr.retries=3' });

    expect(response.json<LogsBody>().logs).toHaveLength(1);
  });

  it('rejects bad parameters with the documented error shape', async () => {
    const cases = [
      ['/logs?since=yesterday', 'invalid since timestamp'],
      [
        '/logs?since=2026-07-21T00:00:00Z&until=2026-07-20T00:00:00Z',
        'until must not be earlier than since',
      ],
      ['/logs?level=critical', "unsupported level: 'critical'"],
      ['/logs?limit=ten', 'limit must be an integer'],
      ['/logs?limit=1001', 'limit must be between 1 and 1000'],
      ['/logs?cursor=nonsense', 'invalid cursor'],
    ] as const;

    for (const [url, error] of cases) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error });
    }
  });

  it('aggregates into buckets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m',
    });
    const body = response.json<BucketsBody>();

    expect(response.statusCode).toBe(200);
    expect(body.buckets).toHaveLength(3);
    expect(body.buckets[0]).toEqual({
      start: '2026-07-20T14:00:00Z',
      group: null,
      count: 1,
    });
  });

  it('aggregates with a grouping', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1h&group_by=service',
    });

    expect(response.json<BucketsBody>().buckets).toEqual([
      { start: '2026-07-20T14:00:00Z', group: 'auth', count: 2 },
      { start: '2026-07-20T14:00:00Z', group: 'checkout', count: 1 },
    ]);
  });

  it('requires a range and a bucket to aggregate', async () => {
    const cases = [
      ['/logs/aggregate?bucket=1m', 'since is required'],
      [
        '/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z',
        'bucket is required',
      ],
      [
        '/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=30s',
        "unsupported bucket: '30s'",
      ],
    ] as const;

    for (const [url, error] of cases) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error });
    }
  });

  it('survives injection attempts through every filter', async () => {
    const payload = encodeURIComponent("'; DROP TABLE logs; --");
    const urls = [
      `/logs?service=${payload}`,
      `/logs?q=${payload}`,
      `/logs?attr.${payload}=${payload}`,
      `/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&service=${payload}`,
    ];

    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }

    const survived = await pool.query<{ count: string }>('SELECT count(*) AS count FROM logs');
    expect(survived.rows[0]?.count).toBe('3');
  });
});
