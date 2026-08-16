import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { LogsRepository } from '../db/logs-repository.js';
import type { WriteBuffer } from '../ingest/write-buffer.js';
import { registerHealthRoute } from './routes/health.js';
import type { Readiness } from './routes/health.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerLogsQueryRoutes } from './routes/logs-query.js';

export interface ServerDeps {
  config: Config;
  readiness: Readiness;
  logs: LogsRepository;
  ingest: WriteBuffer;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    // Per-request logging is the single largest avoidable cost on the ingest path.
    logger: false,
    keepAliveTimeout: 72_000,
    bodyLimit: deps.config.maxBodyBytes,
  });

  // Ingest validates the payload itself, so take the body as bytes and parse it exactly once.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    void reply.code(status).send({ error: status >= 500 ? 'internal error' : error.message });
  });

  registerHealthRoute(app, deps.readiness);
  registerLogsRoutes(app, deps.ingest);
  registerLogsQueryRoutes(app, deps.logs);

  return app;
}
