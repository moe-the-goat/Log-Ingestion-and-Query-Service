import { describe, expect, it } from 'vitest';
import { parseAggregateQuery, parseLogQuery } from '../../src/domain/query.js';
import { encodeCursor } from '../../src/domain/cursor.js';

function errorFor(params: Record<string, unknown>): string {
  const result = parseLogQuery(params);
  if (result.ok) throw new Error('expected the query to be rejected');
  return result.error;
}

function aggregateErrorFor(params: Record<string, unknown>): string {
  const result = parseAggregateQuery(params);
  if (result.ok) throw new Error('expected the query to be rejected');
  return result.error;
}

const RANGE = { since: '2026-07-20T00:00:00Z', until: '2026-07-21T00:00:00Z' };

describe('parseLogQuery', () => {
  it('applies defaults when nothing is given', () => {
    const result = parseLogQuery({});

    expect(result).toEqual({
      ok: true,
      query: {
        filters: {
          service: undefined,
          level: undefined,
          sinceMs: undefined,
          untilMs: undefined,
          q: undefined,
          attributes: [],
        },
        limit: 100,
        cursor: undefined,
      },
    });
  });

  it('reads every filter', () => {
    const result = parseLogQuery({
      service: 'checkout',
      level: 'error',
      ...RANGE,
      q: 'declined',
      'attr.user_id': '42',
      'attr.region': 'eu-west',
      limit: '250',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.query.limit).toBe(250);
    expect(result.query.filters.service).toBe('checkout');
    expect(result.query.filters.level).toBe('error');
    expect(result.query.filters.q).toBe('declined');
    expect(result.query.filters.sinceMs).toBe(Date.parse(RANGE.since));
    expect(result.query.filters.attributes).toEqual([
      { key: 'user_id', value: '42' },
      { key: 'region', value: 'eu-west' },
    ]);
  });

  it('treats an empty parameter as absent', () => {
    const result = parseLogQuery({ service: '', q: '' });

    expect(result.ok && result.query.filters.service).toBeUndefined();
    expect(result.ok && result.query.filters.q).toBeUndefined();
  });

  it('rejects invalid timestamps', () => {
    expect(errorFor({ since: 'yesterday' })).toBe('invalid since timestamp');
    expect(errorFor({ until: '2026-02-30T00:00:00Z' })).toBe('invalid until timestamp');
  });

  it('rejects a range that runs backwards but allows an empty one', () => {
    expect(errorFor({ since: RANGE.until, until: RANGE.since })).toBe(
      'until must not be earlier than since',
    );
    expect(parseLogQuery({ since: RANGE.since, until: RANGE.since }).ok).toBe(true);
  });

  it('rejects an unsupported level', () => {
    expect(errorFor({ level: 'critical' })).toBe("unsupported level: 'critical'");
  });

  it('rejects limits that are not integers in range', () => {
    expect(errorFor({ limit: 'ten' })).toBe('limit must be an integer');
    expect(errorFor({ limit: '10.5' })).toBe('limit must be an integer');
    expect(errorFor({ limit: '-1' })).toBe('limit must be an integer');
    expect(errorFor({ limit: '0' })).toBe('limit must be between 1 and 1000');
    expect(errorFor({ limit: '1001' })).toBe('limit must be between 1 and 1000');
    expect(parseLogQuery({ limit: '1000' }).ok).toBe(true);
  });

  it('rejects a repeated parameter', () => {
    expect(errorFor({ service: ['a', 'b'] })).toBe('service must be given once');
  });

  it('accepts a cursor it produced and rejects a broken one', () => {
    const cursor = encodeCursor({ timestampMs: 1_753_021_921_123, id: '17' });

    expect(parseLogQuery({ cursor }).ok).toBe(true);
    expect(errorFor({ cursor: 'nonsense' })).toBe('invalid cursor');
  });
});

describe('parseAggregateQuery', () => {
  it('reads a complete request', () => {
    const result = parseAggregateQuery({ ...RANGE, bucket: '1h', group_by: 'service' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.query.bucket).toBe('1h');
    expect(result.query.groupBy).toBe('service');
  });

  it('leaves group_by unset when it is not asked for', () => {
    const result = parseAggregateQuery({ ...RANGE, bucket: '1m' });

    expect(result.ok && result.query.groupBy).toBeUndefined();
  });

  it('requires the range and the bucket', () => {
    expect(aggregateErrorFor({ until: RANGE.until, bucket: '1m' })).toBe('since is required');
    expect(aggregateErrorFor({ since: RANGE.since, bucket: '1m' })).toBe('until is required');
    expect(aggregateErrorFor(RANGE)).toBe('bucket is required');
  });

  it('rejects unsupported buckets and groupings', () => {
    expect(aggregateErrorFor({ ...RANGE, bucket: '30s' })).toBe("unsupported bucket: '30s'");
    expect(aggregateErrorFor({ ...RANGE, bucket: '1m', group_by: 'message' })).toBe(
      "unsupported group_by: 'message'",
    );
  });

  it('accepts every supported bucket', () => {
    for (const bucket of ['1m', '5m', '1h', '1d']) {
      expect(parseAggregateQuery({ ...RANGE, bucket }).ok).toBe(true);
    }
  });
});
