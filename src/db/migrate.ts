import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

// Arbitrary but fixed: every instance takes the same lock so only one migrates at a time.
const ADVISORY_LOCK_KEY = 8_142_539;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export async function runMigrations(pool: Pool, logger: Logger): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(applied.rows.map((row) => row.name));

    for (const name of files) {
      if (done.has(name)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      const started = Date.now();

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }

      logger.info('migration applied', { name, durationMs: Date.now() - started });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
