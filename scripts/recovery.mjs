import { createRedisConnection, replayOrder, saleKey } from '../packages/redis/dist/index.js';
import { parseConfiguration } from '../packages/configuration/dist/index.js';
const config = parseConfiguration(process.env, 'worker');
const [action, sale, streamId] = process.argv.slice(2);
if (!sale || !['inspect', 'replay'].includes(action) || (action === 'replay' && !/^\d+-\d+$/.test(streamId ?? ''))) {
  throw new Error('Usage: recovery.mjs inspect SALE | replay SALE STREAM_ID');
}
const redis = createRedisConnection(config.redisUrl, 'durability');
try {
  await redis.connect();
  if (action === 'inspect') {
    // Explicit operator output; service logs never include these identifiers.
    console.log(JSON.stringify({ reconciliation: await redis.hGet(saleKey(sale), 'recovery_diagnostic'), retries: await redis.hGetAll(`${saleKey(sale)}:retries`), quarantine: await redis.hGetAll(`${saleKey(sale)}:quarantine`) }, null, 2));
  } else {
    await replayOrder(redis, sale, streamId);
    console.log('Replay requested; safe to repeat');
  }
} finally { if (redis.isOpen) redis.destroy(); }
