import type { FastifyInstance } from 'fastify';

export interface Readiness {
  isReady(): boolean;
}

export function registerHealthRoute(app: FastifyInstance, readiness: Readiness): void {
  app.get('/health', (_request, reply) => {
    if (!readiness.isReady()) {
      return reply.code(503).send({ status: 'starting' });
    }
    return reply.send({ status: 'ok' });
  });
}
