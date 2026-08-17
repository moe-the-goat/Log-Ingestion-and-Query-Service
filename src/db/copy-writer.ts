import { finished } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import type { Pool } from 'pg';
import type { LogRecord } from '../domain/log.js';
import { COPY_COLUMNS, encodeBinaryCopy, encodeTextCopy } from './copy-encoder.js';
import { buildRollupStatements } from './rollup.js';
import type { LogWriter } from './log-writer.js';

export type CopyFormat = 'binary' | 'text';

const STATEMENTS: Record<CopyFormat, string> = {
  binary: `COPY logs (${COPY_COLUMNS}) FROM STDIN WITH (FORMAT binary)`,
  text: `COPY logs (${COPY_COLUMNS}) FROM STDIN`,
};

export function createCopyWriter(pool: Pool, format: CopyFormat): LogWriter {
  const statement = STATEMENTS[format];
  const encode = format === 'binary' ? encodeBinaryCopy : encodeTextCopy;

  return {
    // An explicit transaction makes a flush all-or-nothing across the copy and the rollup.
    async write(records: readonly LogRecord[]): Promise<void> {
      if (records.length === 0) return;

      const payload = encode(records);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const stream = client.query(copyFrom(statement));
        const completed = finished(stream);
        stream.end(payload);
        await completed;

        // Same transaction as the rows, so the rollup cannot drift from what it summarises.
        for (const rollup of buildRollupStatements(records)) {
          await client.query(rollup.text, rollup.values);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
