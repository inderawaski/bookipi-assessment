import Fastify from 'fastify';
import type { Health } from '@flash/contracts';
export function createHealthServer(probe: () => Promise<void>) {
  const app = Fastify({
    logger: true,
    requestTimeout: 5000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    bodyLimit: 16384,
  });
  app.get('/health/live', async (): Promise<Health> => ({ status: 'running' }));
  app.get('/health/ready', async (_request, reply): Promise<Health> => {
    try {
      await probe();
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
  return app;
}
