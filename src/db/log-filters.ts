import type { LogFilters } from '../domain/query.js';

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface SqlFragment {
  text: string;
  values: unknown[];
}

// Turns a user-supplied value into a LIKE pattern that matches it literally, so % and _ in a
// search term stay characters instead of becoming wildcards.
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

// Attributes keep their original JSON types, so an attr filter has to match both the text form
// and, when the value looks like one, the number or boolean form. Both arms are containment
// checks, so both can use the GIN index.
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

// Every user value becomes a placeholder and every attribute key travels inside a jsonb
// parameter, so no caller-supplied text is ever concatenated into the statement.
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
