import { createDatabase, migrate, persistSale } from '../packages/database/dist/index.js';
import { createRedisConnection, assertRedisSafety, initializeAdmission } from '../packages/redis/dist/index.js';
import { parseConfiguration } from '../packages/configuration/dist/index.js';
const config = parseConfiguration(process.env, 'api');
const database = createDatabase(config.databaseUrl, config.databasePoolSize, config.dependencyTimeoutMs);
const redis = createRedisConnection(config.redisUrl, 'durability');
try {
  if (process.argv[2] === 'migrate') {
    await migrate(database);
    console.log('Schema migrated');
  } else if (process.argv[2] === 'configure' && process.argv.length === 7) {
    if (!/^\d+$/.test(process.argv[6])) throw new Error('Stock must be a nonnegative integer');
    await redis.connect();
    await assertRedisSafety(redis);
    const sale = await persistSale(database, { id: process.argv[3], startsAt: process.argv[4], endsAt: process.argv[5], initialStock: Number(process.argv[6]) });
    await initializeAdmission(redis, sale);
    console.log(`Configured ${sale.id}${sale.initialStock === 0 ? ' (sold out)' : ''}`);
  } else throw new Error('Usage: sale.mjs migrate | configure ID START_ISO END_ISO STOCK');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Sale configuration failed');
  process.exitCode = 1;
} finally {
  if (redis.isOpen) redis.destroy();
  await database.end();
}
