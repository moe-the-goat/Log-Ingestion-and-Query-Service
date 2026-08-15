import { describe, expect, it } from 'vitest';
import { encodeBinaryCopy, encodeTextCopy } from '../../src/db/copy-encoder.js';
import type { LogRecord } from '../../src/domain/log.js';

const SIGNATURE = Buffer.from([0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00]);
const POSTGRES_EPOCH_MS = 946_684_800_000;

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: Date.parse('2026-07-20T14:32:01.123Z'),
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: { user_id: '42' },
    ...overrides,
  };
}

describe('encodeBinaryCopy', () => {
  it('starts with the signature and ends with the trailer', () => {
    const buffer = encodeBinaryCopy([record()]);

    expect(buffer.subarray(0, 11)).toEqual(SIGNATURE);
    expect(buffer.readInt32BE(11)).toBe(0);
    expect(buffer.readInt32BE(15)).toBe(0);
    expect(buffer.readInt16BE(buffer.length - 2)).toBe(-1);
  });

  it('fills the buffer exactly, with no slack', () => {
    const buffer = encodeBinaryCopy([record(), record({ message: 'a'.repeat(500) })]);
    let offset = 19;

    for (let row = 0; row < 2; row += 1) {
      expect(buffer.readInt16BE(offset)).toBe(6);
      offset += 2;
      for (let field = 0; field < 6; field += 1) {
        offset += 4 + buffer.readInt32BE(offset);
      }
    }

    expect(offset).toBe(buffer.length - 2);
  });

  it('writes the timestamp as microseconds from the postgres epoch', () => {
    const timestampMs = Date.parse('2026-07-20T14:32:01.123Z');
    const buffer = encodeBinaryCopy([record({ timestampMs })]);

    // header, field count, id length and id, then the timestamp length prefix.
    const offset = 19 + 2 + 4 + 8 + 4;
    const micros = buffer.readBigInt64BE(offset);

    expect(micros).toBe(BigInt(timestampMs - POSTGRES_EPOCH_MS) * 1000n);
  });

  it('handles timestamps before the postgres epoch', () => {
    const timestampMs = Date.parse('1995-03-04T05:06:07.008Z');
    const buffer = encodeBinaryCopy([record({ timestampMs })]);
    const micros = buffer.readBigInt64BE(19 + 2 + 4 + 8 + 4);

    expect(micros).toBe(BigInt(timestampMs - POSTGRES_EPOCH_MS) * 1000n);
    expect(micros).toBeLessThan(0n);
  });

  it('prefixes jsonb with its version byte', () => {
    const attributes = { user_id: '42', retries: 3 };
    const buffer = encodeBinaryCopy([record({ attributes })]);
    const text = JSON.stringify(attributes);
    const start = buffer.length - 2 - text.length;

    expect(buffer.readUInt8(start - 1)).toBe(1);
    expect(buffer.subarray(start).toString('utf8', 0, text.length)).toBe(text);
  });

  it('sizes multi-byte text by its bytes, not its characters', () => {
    const message = 'ошибка платежа';
    const buffer = encodeBinaryCopy([record({ message, attributes: {} })]);
    let offset = 19 + 2 + (4 + 8) + (4 + 8) + (4 + 'error'.length) + 4;
    offset += 'checkout'.length;

    expect(buffer.readInt32BE(offset)).toBe(Buffer.byteLength(message));
    expect(buffer.readInt32BE(offset)).toBeGreaterThan(message.length);
  });

  it('returns only a header and trailer for an empty batch', () => {
    expect(encodeBinaryCopy([])).toHaveLength(21);
  });
});

describe('encodeTextCopy', () => {
  it('writes one tab-separated row per record', () => {
    const rows = encodeTextCopy([record(), record()]).toString('utf8').trimEnd().split('\n');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.split('\t')).toHaveLength(6);
  });

  it('escapes the characters that would break the format', () => {
    const text = encodeTextCopy([
      record({ message: 'line\tone\nline\\two\r', attributes: {} }),
    ]).toString('utf8');

    expect(text).toContain('line\\tone\\nline\\\\two\\r');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('writes the timestamp in ISO form', () => {
    const text = encodeTextCopy([record()]).toString('utf8');

    expect(text).toContain('2026-07-20T14:32:01.123Z');
  });
});
