import { it, expect } from 'vitest';
import { assertRedisSafety } from './index.js';
const safe = { appendonly: 'yes', appendfsync: 'everysec', 'maxmemory-policy': 'noeviction' };
for (const [key, value] of [['appendonly', 'no'], ['appendfsync', 'no'], ['maxmemory-policy', 'allkeys-lru']]) {
  it(`refuses unsafe Redis ${key}`, async () => {
    await expect(assertRedisSafety({ configGet: async () => ({ ...safe, [key!]: value! }) })).rejects.toThrow('Redis requires');
  });
}
it('accepts the supported persistence configuration', async () => {
  await expect(assertRedisSafety({ configGet: async () => safe })).resolves.toBeUndefined();
});
