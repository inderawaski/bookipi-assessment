import { it, expect } from 'vitest';
import { assertRedisSafety } from './index.js';
const safe = {
  appendonly: 'yes',
  appendfsync: 'everysec',
  'maxmemory-policy': 'noeviction',
};
for (const [key, value] of [
  ['appendonly', 'no'],
  ['appendfsync', 'no'],
  ['maxmemory-policy', 'allkeys-lru'],
]) {
  it(`refuses unsafe Redis ${key}`, async () => {
    await expect(
      assertRedisSafety({
        configGet: async () => ({ ...safe, [key!]: value! }),
      }),
    ).rejects.toThrow('Redis requires');
  });
}
it('accepts the supported persistence configuration', async () => {
  await expect(
    assertRedisSafety({ configGet: async () => safe }),
  ).resolves.toBeUndefined();
});

it('checks AOF write health through the control-plane health check', async () => {
  const { assertRedisHealth } = await import('./index.js');
  const configGet = async () => ({
    appendonly: 'yes',
    appendfsync: 'everysec',
    'maxmemory-policy': 'noeviction',
  });
  await expect(
    assertRedisHealth({
      configGet,
      info: async () => 'aof_enabled:1\r\naof_last_write_status:ok\r\n',
    }),
  ).resolves.toBeUndefined();
  await expect(
    assertRedisHealth({
      configGet,
      info: async () => 'aof_enabled:1\r\naof_last_write_status:err\r\n',
    }),
  ).rejects.toThrow('AOF persistence unavailable');
});
