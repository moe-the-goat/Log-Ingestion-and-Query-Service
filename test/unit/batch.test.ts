import { describe, expect, it } from 'vitest';
import { parseIngestBatch } from '../../src/domain/batch.js';

const NOW = Date.parse('2026-07-20T14:32:01.000Z');

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

const valid = {
  timestamp: '2026-07-20T14:32:01.123Z',
  level: 'error',
  service: 'checkout',
  message: 'payment declined',
};

describe('parseIngestBatch', () => {
  it('accepts a batch of one', () => {
    const result = parseIngestBatch(body({ logs: [valid] }), NOW);

    expect(result.ok && result.batch.records).toHaveLength(1);
    expect(result.ok && result.batch.rejected).toEqual([]);
  });

  it('keeps valid entries and reports rejected ones by index', () => {
    const result = parseIngestBatch(
      body({
        logs: [
          valid,
          { ...valid, level: 'critical' },
          valid,
          { ...valid, service: '' },
          { ...valid, attributes: { nested: { a: 1 } } },
        ],
      }),
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.records).toHaveLength(2);
    expect(result.batch.rejected).toEqual([
      { index: 1, reason: "invalid level: 'critical'" },
      { index: 3, reason: 'service must be a non-empty string' },
      { index: 4, reason: 'attributes.nested must be a string, number or boolean' },
    ]);
  });

  it('reports every entry when all of them are invalid', () => {
    const result = parseIngestBatch(body({ logs: [{ level: 'nope' }, {}] }), NOW);

    expect(result.ok && result.batch.records).toHaveLength(0);
    expect(result.ok && result.batch.rejected).toHaveLength(2);
  });

  it('rejects malformed JSON', () => {
    expect(parseIngestBatch(Buffer.from('{"logs": [', 'utf8'), NOW)).toEqual({
      ok: false,
      error: 'malformed JSON body',
    });
    expect(parseIngestBatch(Buffer.from('', 'utf8'), NOW)).toEqual({
      ok: false,
      error: 'malformed JSON body',
    });
  });

  it('rejects a wrong top-level structure', () => {
    expect(parseIngestBatch(body([valid]), NOW)).toEqual({
      ok: false,
      error: 'body must be a JSON object',
    });
    expect(parseIngestBatch(body('logs'), NOW)).toEqual({
      ok: false,
      error: 'body must be a JSON object',
    });
    expect(parseIngestBatch(body({ entries: [valid] }), NOW)).toEqual({
      ok: false,
      error: 'logs must be an array',
    });
    expect(parseIngestBatch(body({ logs: {} }), NOW)).toEqual({
      ok: false,
      error: 'logs must be an array',
    });
    expect(parseIngestBatch(body({ logs: [] }), NOW)).toEqual({
      ok: false,
      error: 'logs must not be empty',
    });
  });
});
