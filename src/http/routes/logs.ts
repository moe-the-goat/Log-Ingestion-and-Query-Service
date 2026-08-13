import type { FastifyInstance } from 'fastify';
import type { LogsRepository } from '../../db/logs-repository.js';
import { parseIngestBatch } from '../../domain/batch.js';

export function registerLogsRoutes(app: FastifyInstance, logs: LogsRepository): void {
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

    await logs.insert(records);

    return reply.send({ accepted: records.length, rejected });
  });
}
