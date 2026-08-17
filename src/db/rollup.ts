import type { LogRecord } from '../domain/log.js';

const MINUTE_MS = 60_000;

// Four parameters per group against the 65535 a statement allows, with room to spare.
const MAX_GROUPS_PER_STATEMENT = 4_000;

export interface RollupStatement {
  text: string;
  values: unknown[];
}

interface Group {
  bucketMs: number;
  service: string;
  level: string;
  count: number;
}

function compare(a: Group, b: Group): number {
  if (a.bucketMs !== b.bucketMs) return a.bucketMs - b.bucketMs;
  if (a.service !== b.service) return a.service < b.service ? -1 : 1;
  return a.level < b.level ? -1 : a.level > b.level ? 1 : 0;
}

// Counting in memory avoids reading back what the copy just wrote.
export function buildRollupStatements(records: readonly LogRecord[]): RollupStatement[] {
  if (records.length === 0) return [];

  const groups = new Map<string, Group>();

  for (const record of records) {
    const bucketMs = record.timestampMs - (record.timestampMs % MINUTE_MS);
    const key = `${String(bucketMs)} ${record.service} ${record.level}`;
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, { bucketMs, service: record.service, level: record.level, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  // Sorted so concurrent flushes take row locks in the same order; unordered upserts deadlock.
  const ordered = [...groups.values()].sort(compare);
  const statements: RollupStatement[] = [];

  for (let start = 0; start < ordered.length; start += MAX_GROUPS_PER_STATEMENT) {
    const chunk = ordered.slice(start, start + MAX_GROUPS_PER_STATEMENT);
    const tuples: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    for (const group of chunk) {
      tuples.push(`($${index++}::timestamptz,$${index++},$${index++}::log_level,$${index++})`);
      values.push(new Date(group.bucketMs).toISOString(), group.service, group.level, group.count);
    }

    statements.push({
      text: `INSERT INTO log_rollup_1m (bucket, service, level, count)
             VALUES ${tuples.join(',')}
             ON CONFLICT (bucket, service, level)
             DO UPDATE SET count = log_rollup_1m.count + EXCLUDED.count`,
      values,
    });
  }

  return statements;
}
