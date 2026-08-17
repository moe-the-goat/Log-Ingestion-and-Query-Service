import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogWriter } from '../../src/db/log-writer.js';
import type { WriterKind } from '../../src/db/log-writer.js';
import type { LogRecord } from '../../src/domain/log.js';

const BASE = Date.parse('2026-07-20T14:32:01.123Z');

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: BASE,
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: { user_id: '42', retries: 3, cached: false },
    ...overrides,
  };
}

interface StoredRow {
  id: string;
  ts: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}

describe.each<WriterKind>(['binary', 'text', 'insert'])('%s writer', (kind) => {
  let pool: Pool;

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(config.database);
    await runMigrations(pool, createLogger('error'));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM logs');
    await pool.query('DELETE FROM log_rollup_1m');
  });

  it('round-trips a row unchanged', async () => {
    const writer = await createLogWriter(pool, kind);
    await writer.write([record()]);

    const stored = await pool.query<StoredRow>(
      'SELECT id::text AS id, ts, level::text AS level, service, message, attributes FROM logs',
    );
    const row = stored.rows[0];

    expect(stored.rows).toHaveLength(1);
    expect(row?.level).toBe('error');
    expect(row?.service).toBe('checkout');
    expect(row?.message).toBe('payment declined');
    expect(Date.parse(row?.ts ?? '')).toBe(BASE);
    expect(row?.attributes).toEqual({ user_id: '42', retries: 3, cached: false });
  });

  it('preserves attribute types rather than stringifying them', async () => {
    const writer = await createLogWriter(pool, kind);
    await writer.write([record({ attributes: { count: 0, ratio: -1.5, on: true, off: false } })]);

    const stored = await pool.query<{ types: string[] }>(
      `SELECT array[jsonb_typeof(attributes->'count'), jsonb_typeof(attributes->'ratio'),
                    jsonb_typeof(attributes->'on'), jsonb_typeof(attributes->'off')] AS types
         FROM logs`,
    );

    expect(stored.rows[0]?.types).toEqual(['number', 'number', 'boolean', 'boolean']);
  });

  it('stores every level', async () => {
    const writer = await createLogWriter(pool, kind);
    await writer.write([
      record({ level: 'debug' }),
      record({ level: 'info' }),
      record({ level: 'warn' }),
      record({ level: 'error' }),
    ]);

    const stored = await pool.query<{ level: string }>(
      'SELECT level::text AS level FROM logs ORDER BY id',
    );

    expect(stored.rows.map((row) => row.level).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });

  it('survives text that would break a delimited format', async () => {
    const writer = await createLogWriter(pool, kind);
    const message = 'tab\there\nnewline\\backslash\rcarriage "quoted" \'single\'';
    await writer.write([record({ message, service: 'odd\tservice' })]);

    const stored = await pool.query<{ message: string; service: string }>(
      'SELECT message, service FROM logs',
    );

    expect(stored.rows[0]?.message).toBe(message);
    expect(stored.rows[0]?.service).toBe('odd\tservice');
  });

  it('stores multi-byte text correctly', async () => {
    const writer = await createLogWriter(pool, kind);
    const message = 'ошибка платежа — 支払い拒否 🧾';
    await writer.write([record({ message, attributes: { note: 'naïve café' } })]);

    const stored = await pool.query<{ message: string; attributes: Record<string, unknown> }>(
      'SELECT message, attributes FROM logs',
    );

    expect(stored.rows[0]?.message).toBe(message);
    expect(stored.rows[0]?.attributes).toEqual({ note: 'naïve café' });
  });

  it('handles timestamps on both sides of the postgres epoch', async () => {
    const writer = await createLogWriter(pool, kind);
    const old = Date.parse('1995-03-04T05:06:07.008Z');
    const recent = Date.parse('2026-01-02T03:04:05.006Z');
    await writer.write([record({ timestampMs: old }), record({ timestampMs: recent })]);

    const stored = await pool.query<{ ts: string }>('SELECT ts FROM logs ORDER BY ts');

    expect(Date.parse(stored.rows[0]?.ts ?? '')).toBe(old);
    expect(Date.parse(stored.rows[1]?.ts ?? '')).toBe(recent);
  });

  it('gives every row a distinct id under a large batch', async () => {
    const writer = await createLogWriter(pool, kind);
    const batch = Array.from({ length: 5000 }, (_, index) =>
      record({ timestampMs: BASE + index, message: `entry ${String(index)}` }),
    );

    await writer.write(batch);

    const stored = await pool.query<{ total: string; distinct: string }>(
      'SELECT count(*)::text AS total, count(DISTINCT id)::text AS distinct FROM logs',
    );

    expect(stored.rows[0]?.total).toBe('5000');
    expect(stored.rows[0]?.distinct).toBe('5000');
  });

  it('writes nothing for an empty batch', async () => {
    const writer = await createLogWriter(pool, kind);
    await writer.write([]);

    const stored = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM logs');

    expect(stored.rows[0]?.count).toBe('0');
  });
});
