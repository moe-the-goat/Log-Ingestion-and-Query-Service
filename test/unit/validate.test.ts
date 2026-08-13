import { describe, expect, it } from 'vitest';
import { validateEntry } from '../../src/domain/validate.js';

const NOW = Date.parse('2026-07-20T14:32:01.000Z');

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-07-20T14:32:01.123Z',
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    ...overrides,
  };
}

function reasonFor(input: unknown): string {
  const result = validateEntry(input, NOW);
  if (result.ok) throw new Error('expected the entry to be rejected');
  return result.reason;
}

describe('validateEntry', () => {
  it('accepts a complete entry and keeps attribute types', () => {
    const result = validateEntry(
      entry({ attributes: { user_id: '42', region: 'eu-west', retries: 3, cached: false } }),
      NOW,
    );

    expect(result).toEqual({
      ok: true,
      record: {
        timestampMs: Date.parse('2026-07-20T14:32:01.123Z'),
        level: 'error',
        service: 'checkout',
        message: 'payment declined',
        attributes: { user_id: '42', region: 'eu-west', retries: 3, cached: false },
      },
    });
  });

  it('defaults attributes to an empty object when absent', () => {
    const result = validateEntry(entry(), NOW);

    expect(result.ok && result.record.attributes).toEqual({});
  });

  it('rejects anything that is not an object', () => {
    expect(reasonFor(null)).toBe('entry must be an object');
    expect(reasonFor([])).toBe('entry must be an object');
    expect(reasonFor('log')).toBe('entry must be an object');
    expect(reasonFor(7)).toBe('entry must be an object');
  });

  describe('timestamp', () => {
    it('requires the field', () => {
      expect(reasonFor(entry({ timestamp: undefined }))).toBe('timestamp is required');
      expect(reasonFor(entry({ timestamp: null }))).toBe('timestamp is required');
    });

    it('requires a string', () => {
      expect(reasonFor(entry({ timestamp: 1_753_021_921_123 }))).toBe('timestamp must be a string');
    });

    it('rejects formats that are not ISO 8601', () => {
      expect(reasonFor(entry({ timestamp: 'March 5 2020' }))).toContain('invalid timestamp');
      expect(reasonFor(entry({ timestamp: '2026-07-20' }))).toContain('invalid timestamp');
      expect(reasonFor(entry({ timestamp: '2026-07-20 14:32:01Z' }))).toContain(
        'invalid timestamp',
      );
      expect(reasonFor(entry({ timestamp: '' }))).toContain('invalid timestamp');
    });

    it('rejects dates that do not exist', () => {
      expect(reasonFor(entry({ timestamp: '2026-13-01T00:00:00Z' }))).toContain(
        'invalid timestamp',
      );
      expect(reasonFor(entry({ timestamp: '2026-02-30T00:00:00Z' }))).toContain(
        'invalid timestamp',
      );
    });

    it('accepts offsets, fractional seconds and a missing offset', () => {
      const withOffset = validateEntry(entry({ timestamp: '2026-07-20T17:32:01+03:00' }), NOW);
      const withoutOffset = validateEntry(entry({ timestamp: '2026-07-20T14:32:01' }), NOW);
      const withMicros = validateEntry(entry({ timestamp: '2026-07-20T14:32:01.123456Z' }), NOW);

      expect(withOffset.ok && withOffset.record.timestampMs).toBe(
        Date.parse('2026-07-20T14:32:01Z'),
      );
      expect(withoutOffset.ok && withoutOffset.record.timestampMs).toBe(
        Date.parse('2026-07-20T14:32:01Z'),
      );
      expect(withMicros.ok).toBe(true);
    });

    it('accepts old timestamps', () => {
      expect(validateEntry(entry({ timestamp: '2019-01-01T00:00:00Z' }), NOW).ok).toBe(true);
    });

    it('allows up to five minutes of clock skew but no more', () => {
      const withinSkew = new Date(NOW + 5 * 60 * 1000).toISOString();
      const beyondSkew = new Date(NOW + 5 * 60 * 1000 + 1).toISOString();

      expect(validateEntry(entry({ timestamp: withinSkew }), NOW).ok).toBe(true);
      expect(reasonFor(entry({ timestamp: beyondSkew }))).toBe(
        'timestamp is more than 5 minutes in the future',
      );
    });

    it('truncates long values in the reason', () => {
      const reason = reasonFor(entry({ timestamp: 'x'.repeat(500) }));

      expect(reason).toContain('...');
      expect(reason.length).toBeLessThan(120);
    });
  });

  describe('level', () => {
    it('accepts each supported level', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        expect(validateEntry(entry({ level }), NOW).ok).toBe(true);
      }
    });

    it('rejects unknown and wrongly cased levels', () => {
      expect(reasonFor(entry({ level: 'critical' }))).toBe("invalid level: 'critical'");
      expect(reasonFor(entry({ level: 'ERROR' }))).toBe("invalid level: 'ERROR'");
    });

    it('requires the field', () => {
      expect(reasonFor(entry({ level: undefined }))).toBe('level is required');
      expect(reasonFor(entry({ level: 3 }))).toBe('level must be a string');
    });
  });

  describe('service and message', () => {
    it('rejects missing values', () => {
      expect(reasonFor(entry({ service: undefined }))).toBe('service is required');
      expect(reasonFor(entry({ message: undefined }))).toBe('message is required');
    });

    it('rejects empty strings and non-strings', () => {
      expect(reasonFor(entry({ service: '' }))).toBe('service must be a non-empty string');
      expect(reasonFor(entry({ message: '' }))).toBe('message must be a non-empty string');
      expect(reasonFor(entry({ service: 42 }))).toBe('service must be a non-empty string');
      expect(reasonFor(entry({ message: { text: 'hi' } }))).toBe(
        'message must be a non-empty string',
      );
    });
  });

  describe('attributes', () => {
    it('rejects non-objects', () => {
      expect(reasonFor(entry({ attributes: 'user_id=42' }))).toBe('attributes must be an object');
      expect(reasonFor(entry({ attributes: [1, 2] }))).toBe('attributes must be an object');
    });

    it('rejects nested objects and arrays', () => {
      expect(reasonFor(entry({ attributes: { user: { id: '42' } } }))).toBe(
        'attributes.user must be a string, number or boolean',
      );
      expect(reasonFor(entry({ attributes: { tags: ['a'] } }))).toBe(
        'attributes.tags must be a string, number or boolean',
      );
      expect(reasonFor(entry({ attributes: { user: null } }))).toBe(
        'attributes.user must be a string, number or boolean',
      );
    });

    it('accepts an empty object', () => {
      expect(validateEntry(entry({ attributes: {} }), NOW).ok).toBe(true);
    });
  });
});
