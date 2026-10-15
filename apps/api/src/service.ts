import { createHealthServer } from './health.js';
import { createDatabase } from '@flash/database';
import { createRedisConnection, assertRedisSafety } from '@flash/redis';
import { parseConfiguration } from '@flash/configuration';
export async function startService(service: 'api' | 'worker') {
  const config = parseConfiguration(process.env, service);
  const database = createDatabase(config.databaseUrl, config.databasePoolSize, config.dependencyTimeoutMs);
  const redis = createRedisConnection(config.redisUrl, 'commands', config.dependencyTimeoutMs);
  const probe = async () => {
    if (!redis.isReady) await redis.connect();
    await Promise.all([database.query('SELECT 1'), assertRedisSafety(redis)]);
  };
  const app = createHealthServer(probe);
  app.addHook('onClose', async () => { if (redis.isOpen) redis.destroy(); await database.end(); });
  try { await probe(); await app.listen({ host: config.host, port: config.port }); }
  catch { await app.close(); throw new Error(`${service} startup failed: check PostgreSQL availability and Redis persistence configuration`); }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
  return app;
}
