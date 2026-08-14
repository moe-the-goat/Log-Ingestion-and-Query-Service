import { describe, expect, it } from 'vitest';
import { buildWhere } from '../../src/db/log-filters.js';
import type { LogFilters } from '../../src/domain/query.js';

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

const INJECTION = "'; DROP TABLE logs; --";

describe('buildWhere', () => {
  it('matches everything when nothing is filtered', () => {
    expect(buildWhere(filters())).toEqual({ text: 'TRUE', values: [] });
  });

  it('treats since as inclusive and until as exclusive', () => {
    const where = buildWhere(
      filters({
        sinceMs: Date.parse('2026-07-20T00:00:00Z'),
        untilMs: Date.parse('2026-07-21T00:00:00Z'),
      }),
    );

    expect(where.text).toBe('ts >= $1::timestamptz AND ts < $2::timestamptz');
    expect(where.values).toEqual(['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z']);
  });

  it('numbers placeholders from the given offset', () => {
    const where = buildWhere(filters({ service: 'checkout', level: 'error' }), 4);

    expect(where.text).toBe('service = $4 AND level = $5::log_level');
  });

  it('matches an attribute as text and as its native type', () => {
    const where = buildWhere(filters({ attributes: [{ key: 'retries', value: '3' }] }));

    expect(where.text).toBe('(attributes @> $1::jsonb OR attributes @> $2::jsonb)');
    expect(where.values).toEqual(['{"retries":"3"}', '{"retries":3}']);
  });

  it('matches booleans as text and as booleans', () => {
    const where = buildWhere(filters({ attributes: [{ key: 'cached', value: 'true' }] }));

    expect(where.values).toEqual(['{"cached":"true"}', '{"cached":true}']);
  });

  it('keeps a non-numeric attribute as text only', () => {
    const where = buildWhere(filters({ attributes: [{ key: 'region', value: 'eu-west' }] }));

    expect(where.text).toBe('(attributes @> $1::jsonb)');
    expect(where.values).toEqual(['{"region":"eu-west"}']);
  });

  it('escapes wildcards so a search term matches literally', () => {
    const where = buildWhere(filters({ q: '100%_done' }));

    expect(where.text).toBe("message ILIKE $1 ESCAPE '\\'");
    expect(where.values).toEqual(['%100\\%\\_done%']);
  });

  it('never puts a caller-supplied value into the statement', () => {
    const where = buildWhere(
      filters({
        service: INJECTION,
        q: INJECTION,
        attributes: [
          { key: INJECTION, value: INJECTION },
          { key: 'a"; DELETE FROM logs; --', value: '1' },
        ],
      }),
    );

    expect(where.text).not.toContain('DROP');
    expect(where.text).not.toContain('DELETE');
    expect(where.text).not.toContain(INJECTION);
    expect(where.text).toMatch(/^[\w\s$>@().,'\\=:|]+$/);
  });

  it('carries an injected attribute key inside a json parameter', () => {
    const where = buildWhere(filters({ attributes: [{ key: INJECTION, value: 'x' }] }));

    expect(where.text).toBe('(attributes @> $1::jsonb)');
    expect(where.values).toEqual([JSON.stringify({ [INJECTION]: 'x' })]);
  });

  it('gives every value its own placeholder', () => {
    const where = buildWhere(
      filters({
        sinceMs: 0,
        untilMs: 1,
        service: 'checkout',
        level: 'error',
        q: 'declined',
        attributes: [
          { key: 'region', value: 'eu-west' },
          { key: 'retries', value: '3' },
        ],
      }),
    );

    const placeholders = where.text.match(/\$\d+/g) ?? [];
    expect(placeholders).toEqual(['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8']);
    expect(where.values).toHaveLength(8);
  });
});
