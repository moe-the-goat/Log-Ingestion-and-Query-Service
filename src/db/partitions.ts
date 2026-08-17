import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Every name read back from the catalogue is matched against this before reaching a statement.
const PARTITION_NAME = /^logs_\d{4}_\d{2}_\d{2}$/;

// The default partition holds timestamps outside the managed window and is never dropped.
const DEFAULT_PARTITION = 'logs_default';

// A row already sitting in the default partition blocks the creation of a partition covering it.
const CHECK_VIOLATION = '23514';

export interface PartitionOptions {
  aheadDays: number;
  retentionDays: number;
}

function startOfDay(milliseconds: number): number {
  return milliseconds - (milliseconds % DAY_MS);
}

function partitionName(dayMs: number): string {
  return `logs_${new Date(dayMs).toISOString().slice(0, 10).replace(/-/g, '_')}`;
}

function dayFromName(name: string): number {
  return Date.parse(`${name.slice(5).replace(/_/g, '-')}T00:00:00Z`);
}

const ISO_LITERAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Partition bounds are DDL and cannot be parameters, so the shape is asserted before inlining.
function literal(iso: string): string {
  if (!ISO_LITERAL.test(iso)) throw new Error(`refusing to inline timestamp: ${iso}`);
  return `'${iso}'`;
}

function bounds(dayMs: number): { from: string; to: string } {
  return { from: new Date(dayMs).toISOString(), to: new Date(dayMs + DAY_MS).toISOString() };
}

// The only way to add a partition whose range the default partition already holds rows for.
async function adoptFromDefault(client: PoolClient, name: string, dayMs: number): Promise<void> {
  const { from, to } = bounds(dayMs);

  await client.query('BEGIN');
  try {
    await client.query(
      `CREATE TEMP TABLE partition_intake ON COMMIT DROP AS
         WITH moved AS (
           DELETE FROM ${DEFAULT_PARTITION} WHERE ts >= $1::timestamptz AND ts < $2::timestamptz
           RETURNING *
         )
         SELECT * FROM moved`,
      [from, to],
    );
    await client.query(
      `CREATE TABLE ${name} PARTITION OF logs
         FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
    );
    await client.query('INSERT INTO logs SELECT * FROM partition_intake');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function listPartitions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT child.relname AS name
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'logs'`,
  );
  return result.rows.map((row) => row.name);
}

export async function ensurePartitions(
  pool: Pool,
  options: PartitionOptions,
  logger: Logger,
): Promise<number> {
  const today = startOfDay(Date.now());
  // CREATE TABLE IF NOT EXISTS reports success either way, so existence is checked up front.
  const existing = new Set(await listPartitions(pool));
  const client = await pool.connect();
  let created = 0;

  try {
    // Reaches back over the retention window too, so backfilled history is pruned like the rest.
    for (let offset = -options.retentionDays; offset <= options.aheadDays; offset += 1) {
      const dayMs = today + offset * DAY_MS;
      const name = partitionName(dayMs);
      if (existing.has(name)) continue;

      const { from, to } = bounds(dayMs);

      try {
        await client.query(
          `CREATE TABLE ${name} PARTITION OF logs
             FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
        );
        created += 1;
      } catch (error) {
        if ((error as { code?: string }).code !== CHECK_VIOLATION) throw error;

        await adoptFromDefault(client, name, dayMs);
        created += 1;
        logger.info('partition adopted rows from the default partition', { partition: name });
      }
    }
  } finally {
    client.release();
  }

  return created;
}

// Retention is a DROP of a whole partition: constant time, no row-by-row delete, no vacuum debt.
export async function dropExpiredPartitions(
  pool: Pool,
  options: PartitionOptions,
  logger: Logger,
): Promise<string[]> {
  const cutoff = startOfDay(Date.now()) - options.retentionDays * DAY_MS;

  const existing = await pool.query<{ name: string }>(
    `SELECT child.relname AS name
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'logs' AND child.relname <> $1`,
    [DEFAULT_PARTITION],
  );

  const dropped: string[] = [];

  for (const row of existing.rows) {
    if (!PARTITION_NAME.test(row.name)) continue;

    const dayMs = dayFromName(row.name);
    if (Number.isNaN(dayMs) || dayMs + DAY_MS > cutoff) continue;

    await pool.query(`DROP TABLE IF EXISTS ${row.name}`);
    dropped.push(row.name);
  }

  if (dropped.length > 0) {
    await pool.query('DELETE FROM log_rollup_1m WHERE bucket < $1::timestamptz', [
      new Date(cutoff).toISOString(),
    ]);
    logger.info('dropped expired partitions', { partitions: dropped });
  }

  return dropped;
}
