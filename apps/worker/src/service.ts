import { createOrderConsumer } from './orders/consumer.js';
import { createHealthServer } from './health.js';
import { createDatabase, listSales } from '@flash/database';
import { createRedisConnection, assertRedisSafety, assertAdmissionConfiguration, DurableAdmission, saleKey } from '@flash/redis';
import { parseConfiguration } from '@flash/configuration';
export async function startService(service: 'api' | 'worker') {
  const config = parseConfiguration(process.env, service);
  const database = createDatabase(config.databaseUrl, config.databasePoolSize, config.dependencyTimeoutMs);
  const redis = createRedisConnection(config.redisUrl, 'commands', config.dependencyTimeoutMs);
  const admission = new DurableAdmission(config.redisUrl);
  const recoveredRuns = new Map<string, string>();
  const probe = async () => {
    if (!redis.isReady) await redis.connect();
    await Promise.all([database.query('SELECT 1'), assertRedisSafety(redis)]);
    // An unmigrated bootstrap has no sales. Once present, every configuration must match.
    const schema = await database.query("SELECT to_regclass('public.flash_sale') AS name");
    if (schema.rows[0]?.name) {
      const run = (await redis.info('server')).match(/run_id:([^\r\n]+)/)?.[1];
      if (!run) throw new Error('Missing Redis run ID');
      for (const sale of await listSales(database)) {
        if (recoveredRuns.get(sale.id) === run) {
          try { await assertAdmissionConfiguration(redis, sale); }
          catch {
            await redis.hDel(saleKey(sale.id), 'recovered_run');
            recoveredRuns.delete(sale.id);
            throw new Error('Sale configuration inconsistent; admission fenced, inspect configuration');
          }
        }
        if (recoveredRuns.get(sale.id) !== run) {
          const orders = await database.query<{ orderId: string; identifier: string; admittedAtMs: string }>(
            'SELECT id AS "orderId", user_identifier AS identifier, (extract(epoch FROM admitted_at) * 1000)::bigint::text AS "admittedAtMs" FROM "order" WHERE flash_sale_id = $1', [sale.id]);
          await admission.recover(sale, orders.rows.map(order => ({ orderId: order.orderId, identifier: order.identifier, admittedAtMs: Number(order.admittedAtMs) })));
          console.info('Sale reconciliation completed; accounting validated');
        }
        const [epoch, fault] = await redis.hmGet(saleKey(sale.id), ['recovered_run', 'admission_fault']);
        if (epoch !== run || fault !== null) {
          recoveredRuns.delete(sale.id);
          throw new Error('Admission fenced; inspect allocation accounting and recovery runbook');
        }
        recoveredRuns.set(sale.id, run);
      }
    }
  };
  const app = createHealthServer(probe);
  const consumer: { stop?: () => Promise<void> } = {};
  app.addHook('onClose', async () => { await consumer.stop?.(); if (redis.isOpen) redis.destroy(); await database.end(); });
  try {
    await probe();
    consumer.stop = await createOrderConsumer(config.redisUrl, database, admission,
    async () => [...recoveredRuns.keys()],
    () => app.log.error('Order processing failed; pending work retained'), config.retryPolicy);
    await app.listen({ host: config.host, port: config.port });
  } catch { await app.close(); throw new Error(`${service} startup failed: check PostgreSQL availability, Redis persistence, and sale configuration`); }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
  return app;
}
