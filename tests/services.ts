import { createDatabase } from '../packages/database/src/index.js';
import { createRedisConnection } from '../packages/redis/src/index.js';
export function testServices() {
  const { NODE_ENV, TEST_PROJECT, TEST_DATABASE_URL, TEST_REDIS_URL } =
    process.env;
  if (
    NODE_ENV !== 'test' ||
    !/^flash-test-[0-9a-f-]{36}$/.test(TEST_PROJECT ?? '')
  )
    throw new Error('Use the isolated service test runner');
  if (
    !TEST_DATABASE_URL ||
    !TEST_REDIS_URL ||
    new URL(TEST_DATABASE_URL).pathname !== '/flash_test'
  )
    throw new Error('Missing isolated test endpoints');
  return {
    database: createDatabase(TEST_DATABASE_URL, 2, 1000),
    redis: createRedisConnection(TEST_REDIS_URL, 'commands', 1000),
  };
}
