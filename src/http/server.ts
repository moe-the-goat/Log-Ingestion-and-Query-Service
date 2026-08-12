import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { registerHealthRoute } from './routes/health.js';
import type { Readiness } from './routes/health.js';

export interface ServerDeps {
  config: Config;
  readiness: Readiness;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    // Per-request logging is the single largest avoidable cost on the ingest path.
    logger: false,
    keepAliveTimeout: 72_000,
  });

  registerHealthRoute(app, deps.readiness);

  return app;
}
