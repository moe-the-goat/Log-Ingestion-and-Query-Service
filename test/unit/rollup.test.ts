import { describe, expect, it } from 'vitest';
import { buildRollupStatements } from '../../src/db/rollup.js';
import { canUseRollup } from '../../src/db/log-filters.js';
import type { LogRecord } from '../../src/domain/log.js';
import type { LogFilters } from '../../src/domain/query.js';

const BASE = Date.parse('2026-07-20T14:32:00.000Z');

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: BASE,
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: {},
    ...overrides,
  };
}

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

describe('buildRollupStatements', () => {
  it('returns nothing for an empty batch', () => {
    expect(buildRollupStatements([])).toEqual([]);
  });

  it('counts one group per bucket, service and level', () => {
    const [statement] = buildRollupStatements([
      record(),
      record({ timestampMs: BASE + 30_000 }),
      record({ level: 'info' }),
      record({ service: 'auth' }),
    ]);

    expect(statement?.values).toEqual([
      '2026-07-20T14:32:00.000Z',
      'auth',
      'error',
      1,
      '2026-07-20T14:32:00.000Z',
      'checkout',
      'error',
      2,
      '2026-07-20T14:32:00.000Z',
      'checkout',
      'info',
      1,
    ]);
  });

  it('floors each row to its minute', () => {
    const [statement] = buildRollupStatements([
      record({ timestampMs: BASE + 59_999 }),
      record({ timestampMs: BASE + 60_000 }),
    ]);

    expect(statement?.values[0]).toBe('2026-07-20T14:32:00.000Z');
    expect(statement?.values[4]).toBe('2026-07-20T14:33:00.000Z');
  });

  // Concurrent flushes upsert overlapping rows. Taking them in different orders deadlocks, so
  // the order must depend only on the keys, never on how the batch happened to arrive.
  it('emits groups in a stable order regardless of arrival order', () => {
    const forwards = buildRollupStatements([
      record({ timestampMs: BASE + 120_000, service: 'search' }),
      record({ service: 'auth' }),
      record({ timestampMs: BASE + 60_000 }),
    ]);
    const backwards = buildRollupStatements([
      record({ timestampMs: BASE + 60_000 }),
      record({ service: 'auth' }),
      record({ timestampMs: BASE + 120_000, service: 'search' }),
    ]);

    expect(forwards[0]?.values).toEqual(backwards[0]?.values);
    expect(forwards[0]?.values.slice(0, 3)).toEqual(['2026-07-20T14:32:00.000Z', 'auth', 'error']);
  });

  it('adds to the existing count rather than replacing it', () => {
    const [statement] = buildRollupStatements([record()]);

    expect(statement?.text).toContain('count = log_rollup_1m.count + EXCLUDED.count');
  });

  it('passes every value as a placeholder', () => {
    const [statement] = buildRollupStatements([record(), record({ service: 'auth' })]);
    const placeholders = statement?.text.match(/\$\d+/g) ?? [];

    expect(placeholders).toEqual(['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8']);
    expect(statement?.text).not.toContain('checkout');
  });

  // A flush spread over many minutes produces one group per minute, which would otherwise run
  // past the 65535 parameters a single statement allows.
  it('splits large batches so no statement exceeds the parameter limit', () => {
    const spread = Array.from({ length: 20_000 }, (_, index) =>
      record({ timestampMs: BASE + index * 60_000 }),
    );

    const statements = buildRollupStatements(spread);
    const total = statements.reduce((sum, statement) => sum + statement.values.length, 0);

    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(statement.values.length).toBeLessThanOrEqual(65_535);
    }
    expect(total).toBe(20_000 * 4);
  });
});

describe('canUseRollup', () => {
  const minute = 60_000;
  const aligned = { sinceMs: BASE, untilMs: BASE + 10 * minute };

  it('accepts a minute-aligned range with no row-level filters', () => {
    expect(canUseRollup(filters(aligned))).toBe(true);
    expect(canUseRollup(filters({ ...aligned, service: 'checkout' }))).toBe(true);
    expect(canUseRollup(filters({ ...aligned, level: 'error' }))).toBe(true);
  });

  it('refuses filters the rollup does not store', () => {
    expect(canUseRollup(filters({ ...aligned, q: 'declined' }))).toBe(false);
    expect(
      canUseRollup(filters({ ...aligned, attributes: [{ key: 'region', value: 'eu-west' }] })),
    ).toBe(false);
  });

  it('refuses a range that does not land on minute boundaries', () => {
    expect(canUseRollup(filters({ sinceMs: BASE + 30_000, untilMs: BASE + minute }))).toBe(false);
    expect(canUseRollup(filters({ sinceMs: BASE, untilMs: BASE + 90_000 }))).toBe(false);
  });

  it('refuses an open-ended range', () => {
    expect(canUseRollup(filters({ sinceMs: BASE }))).toBe(false);
    expect(canUseRollup(filters({ untilMs: BASE }))).toBe(false);
  });
});
