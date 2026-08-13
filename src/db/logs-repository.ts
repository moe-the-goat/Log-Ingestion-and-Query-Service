import type { Pool } from 'pg';
import type { LogRecord } from '../domain/log.js';
import { nextId } from '../domain/id.js';

const COLUMNS = 6;

// A statement is capped at 65535 parameters; six per row leaves plenty of headroom here.
const MAX_ROWS_PER_STATEMENT = 1000;

const statements = new Map<number, string>();

export interface LogsRepository {
  insert(records: readonly LogRecord[]): Promise<void>;
}

function insertStatement(rows: number): string {
  const cached = statements.get(rows);
  if (cached !== undefined) return cached;

  const tuples: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const base = row * COLUMNS;
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
  }

  const sql = `INSERT INTO logs (id, ts, level, service, message, attributes) VALUES ${tuples.join(',')}`;
  statements.set(rows, sql);
  return sql;
}

function parameters(records: readonly LogRecord[]): unknown[] {
  const values: unknown[] = new Array<unknown>(records.length * COLUMNS);
  let at = 0;

  for (const record of records) {
    values[at++] = nextId();
    values[at++] = new Date(record.timestampMs).toISOString();
    values[at++] = record.level;
    values[at++] = record.service;
    values[at++] = record.message;
    values[at++] = JSON.stringify(record.attributes);
  }

  return values;
}

export function createLogsRepository(pool: Pool): LogsRepository {
  return {
    // One transaction per batch: the caller is told the batch was accepted only once all of
    // it is committed.
    async insert(records: readonly LogRecord[]): Promise<void> {
      if (records.length === 0) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let start = 0; start < records.length; start += MAX_ROWS_PER_STATEMENT) {
          const chunk = records.slice(start, start + MAX_ROWS_PER_STATEMENT);
          await client.query(insertStatement(chunk.length), parameters(chunk));
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
