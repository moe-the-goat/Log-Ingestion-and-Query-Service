import { describe, expect, it, vi } from 'vitest';
import { QueueFullError, createWriteBuffer } from '../../src/ingest/write-buffer.js';
import type { WriteBufferOptions } from '../../src/ingest/write-buffer.js';
import type { LogWriter } from '../../src/db/log-writer.js';
import type { LogRecord } from '../../src/domain/log.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('error');

function options(overrides: Partial<WriteBufferOptions> = {}): WriteBufferOptions {
  return {
    flushIntervalMs: 5,
    flushMaxBytes: 1024 * 1024,
    queueMaxBytes: 4096,
    maxConcurrentFlushes: 2,
    ...overrides,
  };
}

function records(count: number): LogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    timestampMs: 1_753_021_921_123 + index,
    level: 'info' as const,
    service: 'checkout',
    message: `entry ${String(index)}`,
    attributes: {},
  }));
}

function collectingWriter(): { writer: LogWriter; batches: number[]; rows: LogRecord[] } {
  const batches: number[] = [];
  const rows: LogRecord[] = [];

  return {
    batches,
    rows,
    writer: {
      write: (batch) => {
        batches.push(batch.length);
        rows.push(...batch);
        return Promise.resolve();
      },
    },
  };
}

describe('write buffer', () => {
  it('resolves only after the rows have been written', async () => {
    let released: (() => void) | undefined;
    const writer: LogWriter = {
      write: () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    };
    const buffer = createWriteBuffer(writer, options(), logger);

    let settled = false;
    const submitted = buffer.submit(records(3), 100).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(released).toBeDefined());
    expect(settled).toBe(false);

    released?.();
    await submitted;
    expect(settled).toBe(true);
  });

  it('coalesces separate submissions into one write', async () => {
    const { writer, batches } = collectingWriter();
    const buffer = createWriteBuffer(writer, options({ flushIntervalMs: 20 }), logger);

    await Promise.all([
      buffer.submit(records(2), 50),
      buffer.submit(records(3), 50),
      buffer.submit(records(4), 50),
    ]);

    expect(batches).toEqual([9]);
  });

  it('flushes early once the byte threshold is reached', async () => {
    const { writer, batches } = collectingWriter();
    const buffer = createWriteBuffer(
      writer,
      options({ flushIntervalMs: 60_000, flushMaxBytes: 100 }),
      logger,
    );

    await buffer.submit(records(1), 150);

    expect(batches).toEqual([1]);
  });

  it('sheds once the queue is full instead of growing without bound', async () => {
    const writer: LogWriter = { write: () => new Promise<void>(() => undefined) };
    const buffer = createWriteBuffer(
      writer,
      options({ flushIntervalMs: 60_000, flushMaxBytes: 1024 * 1024, queueMaxBytes: 200 }),
      logger,
    );

    void buffer.submit(records(1), 150);

    await expect(buffer.submit(records(1), 150)).rejects.toBeInstanceOf(QueueFullError);
  });

  it('rejects every waiter in a failed flush', async () => {
    const writer: LogWriter = { write: () => Promise.reject(new Error('copy failed')) };
    const buffer = createWriteBuffer(writer, options(), logger);

    const first = buffer.submit(records(1), 10);
    const second = buffer.submit(records(1), 10);

    await expect(first).rejects.toThrow('copy failed');
    await expect(second).rejects.toThrow('copy failed');
    expect(buffer.stats().failures).toBe(1);
  });

  it('keeps concurrent flushes within the configured limit', async () => {
    let active = 0;
    let peak = 0;
    const writer: LogWriter = {
      write: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
      },
    };
    const buffer = createWriteBuffer(
      writer,
      options({ flushIntervalMs: 1, maxConcurrentFlushes: 2, queueMaxBytes: 1024 * 1024 }),
      logger,
    );

    await Promise.all(Array.from({ length: 20 }, () => buffer.submit(records(1), 10)));

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('writes everything still queued when it closes', async () => {
    const { writer, rows } = collectingWriter();
    const buffer = createWriteBuffer(writer, options({ flushIntervalMs: 60_000 }), logger);

    const submitted = buffer.submit(records(5), 10);
    await buffer.close();
    await submitted;

    expect(rows).toHaveLength(5);
    expect(buffer.stats().rowsWritten).toBe(5);
  });

  it('refuses new work once closed', async () => {
    const { writer } = collectingWriter();
    const buffer = createWriteBuffer(writer, options(), logger);

    await buffer.close();

    await expect(buffer.submit(records(1), 10)).rejects.toThrow('closed');
  });

  it('ignores an empty submission', async () => {
    const { writer, batches } = collectingWriter();
    const buffer = createWriteBuffer(writer, options(), logger);

    await buffer.submit([], 0);

    expect(batches).toEqual([]);
  });
});
