import type { LogRecord } from '../domain/log.js';
import type { LogWriter } from '../db/log-writer.js';
import type { Logger } from '../logger.js';

export class QueueFullError extends Error {}

export interface WriteBufferOptions {
  flushIntervalMs: number;
  flushMaxBytes: number;
  queueMaxBytes: number;
  maxConcurrentFlushes: number;
}

export interface WriteBufferStats {
  pendingRows: number;
  pendingBytes: number;
  inFlight: number;
  flushes: number;
  rowsWritten: number;
  failures: number;
}

export interface WriteBuffer {
  submit(records: readonly LogRecord[], byteCost: number): Promise<void>;
  close(): Promise<void>;
  stats(): WriteBufferStats;
}

interface Waiter {
  records: readonly LogRecord[];
  bytes: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

// Requests hand their rows over and wait for the flush that carries them, so a 200 is only ever
// sent for rows Postgres has already committed. Coalescing many small requests into few large
// copies is what stops throughput depending on the caller's batch size.
export function createWriteBuffer(
  writer: LogWriter,
  options: WriteBufferOptions,
  logger: Logger,
): WriteBuffer {
  let waiters: Waiter[] = [];
  let pendingRows = 0;
  let pendingBytes = 0;
  let inFlight = 0;
  let closed = false;

  let flushes = 0;
  let rowsWritten = 0;
  let failures = 0;

  const flush = (): void => {
    if (waiters.length === 0 || inFlight >= options.maxConcurrentFlushes) return;

    const batch = waiters;
    const rows = pendingRows;
    waiters = [];
    pendingRows = 0;
    pendingBytes = 0;
    inFlight += 1;
    flushes += 1;

    const records = new Array<LogRecord>(rows);
    let at = 0;
    for (const waiter of batch) {
      for (const record of waiter.records) {
        records[at++] = record;
      }
    }

    void writer
      .write(records)
      .then(
        () => {
          rowsWritten += rows;
          for (const waiter of batch) waiter.resolve();
        },
        (error: unknown) => {
          failures += 1;
          logger.error('flush failed', { rows, error });
          for (const waiter of batch) waiter.reject(error);
        },
      )
      .finally(() => {
        inFlight -= 1;
        if (waiters.length > 0) flush();
      });
  };

  const timer = setInterval(flush, options.flushIntervalMs);
  timer.unref();

  return {
    async submit(records: readonly LogRecord[], byteCost: number): Promise<void> {
      if (records.length === 0) return;
      if (closed) throw new Error('write buffer is closed');

      // Shedding here is honest backpressure: the caller is told the rows were not taken,
      // rather than being acknowledged and dropped.
      if (pendingBytes + byteCost > options.queueMaxBytes) {
        throw new QueueFullError('ingest queue is full');
      }

      return new Promise<void>((resolve, reject) => {
        waiters.push({ records, bytes: byteCost, resolve, reject });
        pendingRows += records.length;
        pendingBytes += byteCost;

        if (pendingBytes >= options.flushMaxBytes) flush();
      });
    },

    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);

      // Shutdown only: anything already accepted still has to reach disk before the process ends.
      while (waiters.length > 0 || inFlight > 0) {
        flush();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },

    stats(): WriteBufferStats {
      return { pendingRows, pendingBytes, inFlight, flushes, rowsWritten, failures };
    },
  };
}
