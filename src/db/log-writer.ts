import type { Pool } from 'pg';
import type { LogRecord } from '../domain/log.js';

export const WRITER_KINDS = ['binary', 'text', 'insert'] as const;

export type WriterKind = (typeof WRITER_KINDS)[number];

export interface LogWriter {
  write(records: readonly LogRecord[]): Promise<void>;
}

export async function createLogWriter(pool: Pool, kind: WriterKind): Promise<LogWriter> {
  if (kind === 'insert') {
    const { createLogsRepository } = await import('./logs-repository.js');
    const repository = createLogsRepository(pool);
    return { write: (records) => repository.insert(records) };
  }

  const { createCopyWriter } = await import('./copy-writer.js');
  return createCopyWriter(pool, kind);
}
