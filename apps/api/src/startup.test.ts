import { it, expect } from 'vitest';
import { startService } from './service.js';
it('rejects missing configuration before opening a listener', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try { await expect(startService('api')).rejects.toThrow('Missing DATABASE_URL'); }
  finally { if (original !== undefined) process.env.DATABASE_URL = original; }
});
it('fails startup with a clear error when dependencies are unreachable', async () => {
  const keys = ['DATABASE_URL', 'REDIS_URL', 'DEPENDENCY_TIMEOUT_MS'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/flash', REDIS_URL: 'redis://127.0.0.1:1', DEPENDENCY_TIMEOUT_MS: '100' });
  try { await expect(startService('api')).rejects.toThrow('api startup failed'); }
  finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
