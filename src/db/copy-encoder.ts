import type { LogRecord } from '../domain/log.js';
import { idToString, nextId } from '../domain/id.js';

// PGCOPY\n\377\r\n\0 — the fixed signature every binary COPY stream starts with.
const SIGNATURE = Buffer.from([0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00]);
const HEADER_SIZE = SIGNATURE.length + 4 + 4;
const TRAILER_SIZE = 2;
const FIELD_COUNT = 6;
const LENGTH_SIZE = 4;
const INT64_SIZE = 8;

// Postgres counts time in microseconds from 2000-01-01, not 1970.
const POSTGRES_EPOCH_MS = 946_684_800_000;
const JSONB_VERSION = 1;
const WORD_SPAN = 0x1_0000_0000;

export const COPY_COLUMNS = 'id, ts, level, service, message, attributes';

function writeInt64(target: Buffer, value: number, offset: number): void {
  const high = Math.floor(value / WORD_SPAN);
  target.writeInt32BE(high, offset);
  target.writeUInt32BE(value - high * WORD_SPAN, offset + 4);
}

// Sized up front so a flush costs one allocation rather than one per row.
export function encodeBinaryCopy(records: readonly LogRecord[]): Buffer {
  const count = records.length;
  const attributeTexts: string[] = new Array<string>(count);
  const serviceSizes = new Int32Array(count);
  const messageSizes = new Int32Array(count);
  const attributeSizes = new Int32Array(count);

  let size = HEADER_SIZE + TRAILER_SIZE;

  for (let index = 0; index < count; index += 1) {
    const record = records[index];
    if (record === undefined) continue;

    const attributes = JSON.stringify(record.attributes);
    const serviceSize = Buffer.byteLength(record.service);
    const messageSize = Buffer.byteLength(record.message);
    const attributeSize = Buffer.byteLength(attributes);

    attributeTexts[index] = attributes;
    serviceSizes[index] = serviceSize;
    messageSizes[index] = messageSize;
    attributeSizes[index] = attributeSize;

    size +=
      2 +
      (LENGTH_SIZE + INT64_SIZE) +
      (LENGTH_SIZE + INT64_SIZE) +
      (LENGTH_SIZE + record.level.length) +
      (LENGTH_SIZE + serviceSize) +
      (LENGTH_SIZE + messageSize) +
      (LENGTH_SIZE + 1 + attributeSize);
  }

  const buffer = Buffer.allocUnsafe(size);
  SIGNATURE.copy(buffer, 0);
  buffer.writeInt32BE(0, SIGNATURE.length);
  buffer.writeInt32BE(0, SIGNATURE.length + 4);

  let offset = HEADER_SIZE;

  for (let index = 0; index < count; index += 1) {
    const record = records[index];
    const attributes = attributeTexts[index];
    if (record === undefined || attributes === undefined) continue;

    buffer.writeInt16BE(FIELD_COUNT, offset);
    offset += 2;

    const id = nextId();
    buffer.writeInt32BE(INT64_SIZE, offset);
    buffer.writeInt32BE(id.hi, offset + 4);
    buffer.writeUInt32BE(id.lo, offset + 8);
    offset += LENGTH_SIZE + INT64_SIZE;

    buffer.writeInt32BE(INT64_SIZE, offset);
    writeInt64(buffer, (record.timestampMs - POSTGRES_EPOCH_MS) * 1000, offset + 4);
    offset += LENGTH_SIZE + INT64_SIZE;

    // An enum travels as its label text, so the four levels cost their own bytes and no lookup.
    buffer.writeInt32BE(record.level.length, offset);
    offset += LENGTH_SIZE;
    offset += buffer.write(record.level, offset, 'latin1');

    buffer.writeInt32BE(serviceSizes[index] ?? 0, offset);
    offset += LENGTH_SIZE;
    offset += buffer.write(record.service, offset, 'utf8');

    buffer.writeInt32BE(messageSizes[index] ?? 0, offset);
    offset += LENGTH_SIZE;
    offset += buffer.write(record.message, offset, 'utf8');

    buffer.writeInt32BE((attributeSizes[index] ?? 0) + 1, offset);
    buffer.writeUInt8(JSONB_VERSION, offset + LENGTH_SIZE);
    offset += LENGTH_SIZE + 1;
    offset += buffer.write(attributes, offset, 'utf8');
  }

  buffer.writeInt16BE(-1, offset);

  return buffer;
}

const TEXT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

function escapeCopyText(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (character) => TEXT_ESCAPES[character] ?? character);
}

// The fallback path and the benchmark comparison: same rows, only the wire encoding differs.
export function encodeTextCopy(records: readonly LogRecord[]): Buffer {
  const rows: string[] = new Array<string>(records.length);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;

    rows[index] = [
      idToString(nextId()),
      new Date(record.timestampMs).toISOString(),
      record.level,
      escapeCopyText(record.service),
      escapeCopyText(record.message),
      escapeCopyText(JSON.stringify(record.attributes)),
    ].join('\t');
  }

  return Buffer.from(`${rows.join('\n')}\n`, 'utf8');
}
