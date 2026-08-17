import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogsRepository } from '../../src/db/logs-repository.js';
import { createLogWriter } from '../../src/db/log-writer.js';
import { createWriteBuffer } from '../../src/ingest/write-buffer.js';
import type { WriteBuffer } from '../../src/ingest/write-buffer.js';
import { createServer } from '../../src/http/server.js';

const valid = {
  timestamp: '2026-07-20T14:32:01.123Z',
  level: 'error',
  service: 'checkout',
  message: 'payment declined',
};

function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/logs',
    headers: { 'content-type': 'application/json' },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

describe('POST /logs', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let ingest: WriteBuffer;

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(config.database);
    await runMigrations(pool, createLogger('error'));

    const writer = await createLogWriter(pool, config.ingest.writer);
    ingest = createWriteBuffer(writer, config.ingest, createLogger('error'));

    app = createServer({
      config,
      readiness: { isReady: () => true },
      logs: createLogsRepository(pool),
      ingest,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await ingest.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM logs');
    await pool.query('DELETE FROM log_rollup_1m');
  });

  it('stores a batch and reports how many were accepted', async () => {
    const response = await post(app, { logs: [valid, { ...valid, level: 'info' }] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, rejected: [] });

    const stored = await pool.query<{ count: string }>('SELECT count(*) AS count FROM logs');
    expect(stored.rows[0]?.count).toBe('2');
  });

  it('stores attributes with their original types', async () => {
    await post(app, {
      logs: [{ ...valid, attributes: { user_id: '42', retries: 3, cached: false } }],
    });

    const stored = await pool.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM logs',
    );
    expect(stored.rows[0]?.attributes).toEqual({ user_id: '42', retries: 3, cached: false });
  });

  it('writes the row exactly as it was sent', async () => {
    await post(app, { logs: [valid] });

    const stored = await pool.query<{
      ts: string;
      level: string;
      service: string;
      message: string;
    }>('SELECT ts, level, service, message FROM logs');

    const row = stored.rows[0];
    expect(row?.level).toBe('error');
    expect(row?.service).toBe('checkout');
    expect(row?.message).toBe('payment declined');
    expect(Date.parse(row?.ts ?? '')).toBe(Date.parse(valid.timestamp));
  });

  it('accepts the valid part of a mixed batch', async () => {
    const response = await post(app, {
      logs: [valid, { ...valid, level: 'critical' }, { ...valid, message: '' }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [
        { index: 1, reason: "invalid level: 'critical'" },
        { index: 2, reason: 'message must be a non-empty string' },
      ],
    });

    const stored = await pool.query<{ count: string }>('SELECT count(*) AS count FROM logs');
    expect(stored.rows[0]?.count).toBe('1');
  });

  it('rejects the request when no entry is valid and stores nothing', async () => {
    const response = await post(app, { logs: [{ ...valid, level: 'critical' }] });

    const body = response.json<{ rejected: unknown }>();
    expect(response.statusCode).toBe(400);
    expect(body.rejected).toEqual([{ index: 0, reason: "invalid level: 'critical'" }]);

    const stored = await pool.query<{ count: string }>('SELECT count(*) AS count FROM logs');
    expect(stored.rows[0]?.count).toBe('0');
  });

  it('rejects malformed JSON and wrong top-level structures', async () => {
    const malformed = await post(app, '{"logs": [');
    const wrongShape = await post(app, [valid]);
    const missingLogs = await post(app, { entries: [valid] });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'malformed JSON body' });
    expect(wrongShape.statusCode).toBe(400);
    expect(missingLogs.statusCode).toBe(400);
    expect(missingLogs.json()).toEqual({ error: 'logs must be an array' });
  });

  it('gives every stored row a distinct id', async () => {
    const logs = Array.from({ length: 250 }, (_, index) => ({
      ...valid,
      message: `entry ${String(index)}`,
    }));
    await post(app, { logs });

    const stored = await pool.query<{ count: string }>(
      'SELECT count(DISTINCT id) AS count FROM logs',
    );
    expect(stored.rows[0]?.count).toBe('250');
  });

  it('keeps serving health while ingesting', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });

    expect(health.statusCode).toBe(200);
  });
});
