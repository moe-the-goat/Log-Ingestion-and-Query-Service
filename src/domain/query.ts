import { LOG_LEVELS } from './log.js';
import type { LogLevel } from './log.js';
import { parseTimestampMs } from './time.js';
import { decodeCursor } from './cursor.js';
import type { Cursor } from './cursor.js';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export const BUCKET_SIZES = ['1m', '5m', '1h', '1d'] as const;
export const GROUP_BY_FIELDS = ['service', 'level'] as const;

export type BucketSize = (typeof BUCKET_SIZES)[number];
export type GroupBy = (typeof GROUP_BY_FIELDS)[number];

const ATTRIBUTE_PREFIX = 'attr.';
const INTEGER = /^\d+$/;

const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);
const BUCKETS: ReadonlySet<string> = new Set(BUCKET_SIZES);
const GROUPS: ReadonlySet<string> = new Set(GROUP_BY_FIELDS);

export interface AttributeFilter {
  key: string;
  value: string;
}

export interface LogFilters {
  service?: string | undefined;
  level?: LogLevel | undefined;
  sinceMs?: number | undefined;
  untilMs?: number | undefined;
  q?: string | undefined;
  attributes: AttributeFilter[];
}

export interface LogQuery {
  filters: LogFilters;
  limit: number;
  cursor?: Cursor | undefined;
}

export interface AggregateQuery {
  filters: LogFilters;
  bucket: BucketSize;
  groupBy?: GroupBy | undefined;
}

export type QueryParams = Record<string, unknown>;

export type Parsed<T> = { ok: true; query: T } | { ok: false; error: string };

type Field<T> = { ok: true; value: T } | { ok: false; error: string };

// A repeated parameter arrives as an array; rather than silently picking one, say so.
function readSingle(params: QueryParams, key: string): Field<string | undefined> {
  const raw = params[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${key} must be given once` };
  if (raw === '') return { ok: true, value: undefined };
  return { ok: true, value: raw };
}

function readTimestamp(params: QueryParams, key: string): Field<number | undefined> {
  const raw = readSingle(params, key);
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: undefined };

  const milliseconds = parseTimestampMs(raw.value);
  if (milliseconds === null) return { ok: false, error: `invalid ${key} timestamp` };
  return { ok: true, value: milliseconds };
}

function readLimit(params: QueryParams): Field<number> {
  const raw = readSingle(params, 'limit');
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: DEFAULT_LIMIT };

  if (!INTEGER.test(raw.value)) return { ok: false, error: 'limit must be an integer' };

  const limit = Number(raw.value);
  if (limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be between 1 and ${String(MAX_LIMIT)}` };
  }
  return { ok: true, value: limit };
}

function readAttributes(params: QueryParams): Field<AttributeFilter[]> {
  const attributes: AttributeFilter[] = [];

  for (const [name, value] of Object.entries(params)) {
    if (!name.startsWith(ATTRIBUTE_PREFIX)) continue;

    const key = name.slice(ATTRIBUTE_PREFIX.length);
    if (key === '') return { ok: false, error: 'attribute filter is missing a key' };
    if (typeof value !== 'string') return { ok: false, error: `${name} must be given once` };

    attributes.push({ key, value });
  }

  return { ok: true, value: attributes };
}

function readFilters(params: QueryParams): Field<LogFilters> {
  const service = readSingle(params, 'service');
  if (!service.ok) return service;

  const level = readSingle(params, 'level');
  if (!level.ok) return level;
  if (level.value !== undefined && !LEVELS.has(level.value)) {
    return { ok: false, error: `unsupported level: '${level.value}'` };
  }

  const since = readTimestamp(params, 'since');
  if (!since.ok) return since;

  const until = readTimestamp(params, 'until');
  if (!until.ok) return until;

  if (since.value !== undefined && until.value !== undefined && until.value < since.value) {
    return { ok: false, error: 'until must not be earlier than since' };
  }

  const q = readSingle(params, 'q');
  if (!q.ok) return q;

  const attributes = readAttributes(params);
  if (!attributes.ok) return attributes;

  return {
    ok: true,
    value: {
      service: service.value,
      level: level.value as LogLevel | undefined,
      sinceMs: since.value,
      untilMs: until.value,
      q: q.value,
      attributes: attributes.value,
    },
  };
}

export function parseLogQuery(params: QueryParams): Parsed<LogQuery> {
  const filters = readFilters(params);
  if (!filters.ok) return { ok: false, error: filters.error };

  const limit = readLimit(params);
  if (!limit.ok) return { ok: false, error: limit.error };

  const rawCursor = readSingle(params, 'cursor');
  if (!rawCursor.ok) return { ok: false, error: rawCursor.error };

  let cursor: Cursor | undefined;
  if (rawCursor.value !== undefined) {
    const decoded = decodeCursor(rawCursor.value);
    if (decoded === null) return { ok: false, error: 'invalid cursor' };
    cursor = decoded;
  }

  return { ok: true, query: { filters: filters.value, limit: limit.value, cursor } };
}

export function parseAggregateQuery(params: QueryParams): Parsed<AggregateQuery> {
  const filters = readFilters(params);
  if (!filters.ok) return { ok: false, error: filters.error };

  if (filters.value.sinceMs === undefined) return { ok: false, error: 'since is required' };
  if (filters.value.untilMs === undefined) return { ok: false, error: 'until is required' };

  const bucket = readSingle(params, 'bucket');
  if (!bucket.ok) return { ok: false, error: bucket.error };
  if (bucket.value === undefined) return { ok: false, error: 'bucket is required' };
  if (!BUCKETS.has(bucket.value)) {
    return { ok: false, error: `unsupported bucket: '${bucket.value}'` };
  }

  const groupBy = readSingle(params, 'group_by');
  if (!groupBy.ok) return { ok: false, error: groupBy.error };
  if (groupBy.value !== undefined && !GROUPS.has(groupBy.value)) {
    return { ok: false, error: `unsupported group_by: '${groupBy.value}'` };
  }

  return {
    ok: true,
    query: {
      filters: filters.value,
      bucket: bucket.value as BucketSize,
      groupBy: groupBy.value as GroupBy | undefined,
    },
  };
}
