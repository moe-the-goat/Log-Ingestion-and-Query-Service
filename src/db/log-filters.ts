import type { LogFilters } from '../domain/query.js';

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface SqlFragment {
  text: string;
  values: unknown[];
}

// Escapes the pattern so % and _ in a search term stay characters instead of wildcards.
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

// Attributes keep their JSON types, so a filter matches the text form and the native one.
function containmentVariants(key: string, value: string): string[] {
  const variants = [JSON.stringify({ [key]: value })];

  if (value === 'true') {
    variants.push(JSON.stringify({ [key]: true }));
  } else if (value === 'false') {
    variants.push(JSON.stringify({ [key]: false }));
  } else if (NUMERIC.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) variants.push(JSON.stringify({ [key]: numeric }));
  }

  return variants;
}

// No caller text reaches the statement: values are placeholders, keys travel inside jsonb.
export function buildWhere(filters: LogFilters, firstIndex = 1): SqlFragment {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let index = firstIndex;

  if (filters.sinceMs !== undefined) {
    conditions.push(`ts >= $${index++}::timestamptz`);
    values.push(new Date(filters.sinceMs).toISOString());
  }

  if (filters.untilMs !== undefined) {
    conditions.push(`ts < $${index++}::timestamptz`);
    values.push(new Date(filters.untilMs).toISOString());
  }

  if (filters.service !== undefined) {
    conditions.push(`service = $${index++}`);
    values.push(filters.service);
  }

  if (filters.level !== undefined) {
    conditions.push(`level = $${index++}::log_level`);
    values.push(filters.level);
  }

  if (filters.q !== undefined) {
    conditions.push(`message ILIKE $${index++} ESCAPE '\\'`);
    values.push(likePattern(filters.q));
  }

  for (const attribute of filters.attributes) {
    const variants = containmentVariants(attribute.key, attribute.value);
    const arms = variants.map(() => `attributes @> $${index++}::jsonb`);
    conditions.push(`(${arms.join(' OR ')})`);
    values.push(...variants);
  }

  return { text: conditions.length === 0 ? 'TRUE' : conditions.join(' AND '), values };
}

// The rollup stores only per-minute counts by service and level, so anything filtering on a
// column it does not hold has to read the base table.
export function canUseRollup(filters: LogFilters): boolean {
  if (filters.attributes.length > 0 || filters.q !== undefined) return false;
  return filters.sinceMs !== undefined && filters.untilMs !== undefined;
}

export function buildRollupWhere(filters: LogFilters, firstIndex = 1): SqlFragment {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let index = firstIndex;
  const placeholder = (): string => `$${index++}`;

  if (filters.sinceMs !== undefined) {
    conditions.push(`bucket >= ${placeholder()}::timestamptz`);
    values.push(new Date(filters.sinceMs).toISOString());
  }

  if (filters.untilMs !== undefined) {
    conditions.push(`bucket < ${placeholder()}::timestamptz`);
    values.push(new Date(filters.untilMs).toISOString());
  }

  if (filters.service !== undefined) {
    conditions.push(`service = ${placeholder()}`);
    values.push(filters.service);
  }

  if (filters.level !== undefined) {
    conditions.push(`level = ${placeholder()}::log_level`);
    values.push(filters.level);
  }

  return { text: conditions.length === 0 ? 'TRUE' : conditions.join(' AND '), values };
}
