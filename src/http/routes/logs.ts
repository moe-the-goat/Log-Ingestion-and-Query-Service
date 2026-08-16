import type { FastifyInstance } from 'fastify';
import { parseIngestBatch } from '../../domain/batch.js';
import { QueueFullError } from '../../ingest/write-buffer.js';
import type { WriteBuffer } from '../../ingest/write-buffer.js';

const RETRY_AFTER_SECONDS = '1';

export function registerLogsRoutes(app: FastifyInstance, ingest: WriteBuffer): void {
  app.post('/logs', async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }

    const parsed = parseIngestBatch(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const { records, rejected } = parsed.batch;
    if (records.length === 0) {
      return reply.code(400).send({ error: 'all entries were rejected', accepted: 0, rejected });
    }

    try {
      // Resolves only once the flush carrying these rows has committed.
      await ingest.submit(records, request.body.length);
    } catch (error) {
      if (error instanceof QueueFullError) {
        return reply
          .code(503)
          .header('retry-after', RETRY_AFTER_SECONDS)
          .send({ error: 'ingest queue is full' });
      }
      throw error;
    }

    return reply.send({ accepted: records.length, rejected });
  });
}
