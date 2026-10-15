import Fastify from 'fastify';
import type { Health } from '@flash/contracts';
export function createHealthServer(probe: () => Promise<void>) {
  const app = Fastify({ logger: true, bodyLimit: 16384 });
  app.get('/health/live', async (): Promise<Health> => ({ status: 'running' }));
  app.get('/health/ready', async (_request, reply): Promise<Health> => {
    try { await probe(); return { status: 'ready' }; }
    catch { reply.code(503); return { status: 'unavailable' }; }
  });
  return app;
}
