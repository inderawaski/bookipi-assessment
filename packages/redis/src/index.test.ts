import { it, expect } from 'vitest';
import { assertRedisSafety } from './index.js';
const safe = { appendonly: 'yes', appendfsync: 'everysec', 'maxmemory-policy': 'noeviction' };
for (const [key, value] of [['appendonly', 'no'], ['appendfsync', 'no'], ['maxmemory-policy', 'allkeys-lru']]) {
  it(`refuses unsafe Redis ${key}`, async () => {
    await expect(assertRedisSafety({ configGet: async () => ({ ...safe, [key!]: value! }), sendCommand: async () => [['waitaof']] })).rejects.toThrow('Redis requires');
  });
}
it('requires WAITAOF support', async () => {
  await expect(assertRedisSafety({ configGet: async () => safe, sendCommand: async () => [null] })).rejects.toThrow('7.2+');
});
it('accepts the supported persistence configuration', async () => {
  await expect(assertRedisSafety({ configGet: async () => safe, sendCommand: async () => [['waitaof']] })).resolves.toBeUndefined();
});
