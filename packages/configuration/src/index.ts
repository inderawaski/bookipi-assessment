type Environment = Record<string, string | undefined>;
function integer(env: Environment, key: string, fallback: number, max = 65535): number {
  const raw = env[key] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`Invalid ${key}: expected integer 1..${max}`);
  return Number(raw);
}
function endpoint(env: Environment, key: string, protocols: string[]): string {
  const raw = env[key];
  if (!raw) throw new Error(`Missing ${key}`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Invalid ${key}: expected URL`); }
  if (!protocols.includes(url.protocol) || !url.hostname) throw new Error(`Invalid ${key}: unsupported URL`);
  return raw;
}
export function parseConfiguration(env: Environment, service: 'api' | 'worker') {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('Invalid NODE_ENV');
  const host = env.HOST ?? '0.0.0.0';
  if (!host.trim()) throw new Error('Invalid HOST');
  return {
    host, port: integer(env, service === 'api' ? 'API_PORT' : 'WORKER_PORT', service === 'api' ? 3000 : 3001),
    databaseUrl: endpoint(env, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: endpoint(env, 'REDIS_URL', ['redis:', 'rediss:']),
    databasePoolSize: integer(env, 'DATABASE_POOL_SIZE', 10, 100),
    dependencyTimeoutMs: integer(env, 'DEPENDENCY_TIMEOUT_MS', 2000, 30000),
  };
}
