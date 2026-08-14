import { describe, expect, it } from 'vitest';
import { parseTimestampMs } from '../../src/domain/time.js';

describe('parseTimestampMs', () => {
  it('reads ISO 8601 with an offset, without one, and with fractions', () => {
    expect(parseTimestampMs('2026-07-20T14:32:01.123Z')).toBe(
      Date.parse('2026-07-20T14:32:01.123Z'),
    );
    expect(parseTimestampMs('2026-07-20T17:32:01+03:00')).toBe(Date.parse('2026-07-20T14:32:01Z'));
    expect(parseTimestampMs('2026-07-20T14:32:01')).toBe(Date.parse('2026-07-20T14:32:01Z'));
  });

  it('rejects shapes that are not ISO 8601', () => {
    expect(parseTimestampMs('March 5 2020')).toBeNull();
    expect(parseTimestampMs('2026-07-20')).toBeNull();
    expect(parseTimestampMs('2026-07-20 14:32:01Z')).toBeNull();
    expect(parseTimestampMs('')).toBeNull();
  });

  it('rejects days that the month does not have', () => {
    expect(parseTimestampMs('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseTimestampMs('2026-04-31T00:00:00Z')).toBeNull();
    expect(parseTimestampMs('2026-13-01T00:00:00Z')).toBeNull();
  });

  it('follows the leap year rules', () => {
    expect(parseTimestampMs('2024-02-29T00:00:00Z')).not.toBeNull();
    expect(parseTimestampMs('2026-02-29T00:00:00Z')).toBeNull();
    expect(parseTimestampMs('2000-02-29T00:00:00Z')).not.toBeNull();
    expect(parseTimestampMs('1900-02-29T00:00:00Z')).toBeNull();
  });
});
