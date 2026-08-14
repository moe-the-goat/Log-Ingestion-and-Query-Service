import type { FastifyInstance } from 'fastify';
import type { LogsRepository } from '../../db/logs-repository.js';
import { parseAggregateQuery, parseLogQuery } from '../../domain/query.js';
import type { QueryParams } from '../../domain/query.js';
import { encodeCursor } from '../../domain/cursor.js';

export function registerLogsQueryRoutes(app: FastifyInstance, logs: LogsRepository): void {
  app.get('/logs', async (request, reply) => {
    const parsed = parseLogQuery(request.query as QueryParams);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const result = await logs.search(parsed.query);

    return reply.send({
      logs: result.logs,
      next_cursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
    });
  });

  app.get('/logs/aggregate', async (request, reply) => {
    const parsed = parseAggregateQuery(request.query as QueryParams);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    return reply.send({ buckets: await logs.aggregate(parsed.query) });
  });
}
