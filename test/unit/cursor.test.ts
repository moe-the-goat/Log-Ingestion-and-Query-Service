import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/domain/cursor.js';

describe('cursor', () => {
  it('round-trips a position', () => {
    const cursor = {
      timestampMs: Date.parse('2026-07-20T14:32:01.123Z'),
      id: '1873350258385223680',
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('encodes to url-safe characters only', () => {
    const encoded = encodeCursor({ timestampMs: 1_753_021_921_123, id: '9223372036854775807' });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects values that are not a cursor', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(Buffer.from('null', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('[1,2]', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}', 'utf8').toString('base64url'))).toBeNull();
  });

  it('rejects an unknown version', () => {
    const payload = Buffer.from(JSON.stringify({ v: 2, t: 1, i: '1' }), 'utf8').toString(
      'base64url',
    );

    expect(decodeCursor(payload)).toBeNull();
  });

  it('rejects a tampered position', () => {
    const cases = [
      { v: 1, t: 'yesterday', i: '1' },
      { v: 1, t: 1.5, i: '1' },
      { v: 1, t: 1, i: 42 },
      { v: 1, t: 1, i: '1; DROP TABLE logs' },
      { v: 1, t: 1, i: '-1' },
      { v: 1, t: 1, i: '12345678901234567890123' },
    ];

    for (const payload of cases) {
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      expect(decodeCursor(encoded)).toBeNull();
    }
  });
});
