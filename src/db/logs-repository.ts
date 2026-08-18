import type { Pool } from 'pg';
import type { Attributes, LogRecord } from '../domain/log.js';
import { idToString, nextId } from '../domain/id.js';
import type { AggregateQuery, BucketSize, GroupBy, LogQuery } from '../domain/query.js';
import type { Cursor } from '../domain/cursor.js';
import { buildRollupWhere, buildWhere, canUseRollup } from './log-filters.js';
import type { SqlFragment } from './log-filters.js';
import { buildRollupStatements } from './rollup.js';

const COLUMNS = 6;
const MINUTE_MS = 60_000;

// A statement is capped at 65535 parameters; six per row leaves plenty of headroom here.
const MAX_ROWS_PER_STATEMENT = 1000;

const statements = new Map<number, string>();

// The API timestamp format is produced in SQL rather than reparsed into a Date on the way out.
const TIMESTAMP_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const BUCKET_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

// Identifiers and intervals can never be parameters, so both come from fixed allowlists.
const BUCKET_INTERVALS: Record<BucketSize, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
};

const GROUP_EXPRESSIONS: Record<GroupBy, string> = {
  service: 'service',
  level: 'level::text',
};

export interface StoredLog {
  id: string;
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Attributes;
}

export interface SearchResult {
  logs: StoredLog[];
  nextCursor: Cursor | null;
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

export interface LogsRepository {
  insert(records: readonly LogRecord[]): Promise<void>;
  search(query: LogQuery): Promise<SearchResult>;
  aggregate(query: AggregateQuery): Promise<AggregateBucket[]>;
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
    values[at++] = idToString(nextId());
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
    // One transaction per batch: accepted is only reported once all of it is committed.
    async insert(records: readonly LogRecord[]): Promise<void> {
      if (records.length === 0) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let start = 0; start < records.length; start += MAX_ROWS_PER_STATEMENT) {
          const chunk = records.slice(start, start + MAX_ROWS_PER_STATEMENT);
          await client.query(insertStatement(chunk.length), parameters(chunk));
        }

        // Both write paths maintain the rollup identically, so the choice cannot change results.
        for (const rollup of buildRollupStatements(records)) {
          await client.query(rollup.text, rollup.values);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    // Reads one row past the limit so next_cursor is null exactly when nothing follows.
    async search(query: LogQuery): Promise<SearchResult> {
      const where = buildWhere(query.filters);
      const conditions = [where.text];
      const values = [...where.values];
      let index = values.length + 1;

      if (query.cursor !== undefined) {
        conditions.push(`(ts, id) < ($${index++}::timestamptz, $${index++}::bigint)`);
        values.push(new Date(query.cursor.timestampMs).toISOString(), query.cursor.id);
      }

      values.push(query.limit + 1);

      const result = await pool.query<StoredLog>(
        `SELECT id::text AS id,
                to_char(ts AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS timestamp,
                level::text AS level,
                service,
                message,
                attributes
           FROM logs
          WHERE ${conditions.join(' AND ')}
          ORDER BY ts DESC, id DESC
          LIMIT $${index}`,
        values,
      );

      const hasMore = result.rows.length > query.limit;
      const logs = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      const last = logs[logs.length - 1];

      return {
        logs,
        nextCursor:
          hasMore && last !== undefined
            ? { timestampMs: Date.parse(last.timestamp), id: last.id }
            : null,
      };
    },

    // Whole minutes come from the rollup and only the partial minutes at each edge are counted
    // from the base table, so an arbitrary range still avoids scanning the rows it covers.
    async aggregate(query: AggregateQuery): Promise<AggregateBucket[]> {
      const filters = query.filters;
      const since = filters.sinceMs;
      const until = filters.untilMs;

      const interval = BUCKET_INTERVALS[query.bucket];
      const group = query.groupBy === undefined ? 'NULL::text' : GROUP_EXPRESSIONS[query.groupBy];
      const values: unknown[] = [interval];

      const fromBase = (source: SqlFragment): string =>
        `SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
                ${group} AS group_value, count(*) AS count
           FROM logs WHERE ${source.text} GROUP BY 1, 2`;

      let source: string;

      const firstWholeMinute = since === undefined ? 0 : Math.ceil(since / MINUTE_MS) * MINUTE_MS;
      const lastWholeMinute = until === undefined ? 0 : Math.floor(until / MINUTE_MS) * MINUTE_MS;

      if (!canUseRollup(filters) || firstWholeMinute >= lastWholeMinute) {
        const where = buildWhere(filters, values.length + 1);
        values.push(...where.values);
        source = fromBase(where);
      } else {
        const middle = buildRollupWhere(
          { ...filters, sinceMs: firstWholeMinute, untilMs: lastWholeMinute },
          values.length + 1,
        );
        values.push(...middle.values);

        const head = buildWhere(
          { ...filters, sinceMs: since, untilMs: firstWholeMinute },
          values.length + 1,
        );
        values.push(...head.values);

        const tail = buildWhere(
          { ...filters, sinceMs: lastWholeMinute, untilMs: until },
          values.length + 1,
        );
        values.push(...tail.values);

        source = `SELECT bucket, group_value, sum(count) AS count FROM (
                    SELECT date_bin($1::interval, bucket, TIMESTAMPTZ '2000-01-01') AS bucket,
                           ${group} AS group_value, count
                      FROM log_rollup_1m WHERE ${middle.text}
                    UNION ALL ${fromBase(head)}
                    UNION ALL ${fromBase(tail)}
                  ) parts GROUP BY 1, 2`;
      }

      const result = await pool.query<{ start: string; group: string | null; count: string }>(
        `SELECT to_char(bucket AT TIME ZONE 'UTC', ${BUCKET_FORMAT}) AS start,
                group_value AS "group",
                count
           FROM (${source}) buckets
          ORDER BY bucket ASC, group_value ASC NULLS FIRST`,
        values,
      );

      return result.rows.map((row) => ({
        start: row.start,
        group: row.group,
        count: Number(row.count),
      }));
    },
  };
}
