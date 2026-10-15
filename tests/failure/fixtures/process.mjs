// Only launched by the isolated failure runner; there is no HTTP fault surface.
import { createDatabase } from '../../../packages/database/dist/index.js';
import { DurableAdmission, createRedisConnection } from '../../../packages/redis/dist/index.js';
import { processOrder } from '../../../apps/worker/dist/orders/consumer.js';
const { boundary, saleId, entry, mode } = JSON.parse(process.argv[2]);
const failpoint = async name => {
  process.send({ boundary: name });
  if (name === boundary) await new Promise(() => {});
};
const gate = new DurableAdmission(process.env.TEST_REDIS_URL, 16, 30000, () => {}, mode === 'admission' ? failpoint : undefined);
if (mode === 'admission') {
  await gate.place(saleId, { identifier: 'person', idempotencyKey: 'key' });
} else {
  const database = createDatabase(process.env.TEST_DATABASE_URL, 1, 1000);
  const redis = createRedisConnection(process.env.TEST_REDIS_URL, 'commands');
  await redis.connect();
  await processOrder(database, redis, gate, saleId, entry, failpoint);
}
process.exit(0);
