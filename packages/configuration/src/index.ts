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
function webOrigin(env: Environment): string | undefined {
  if (env.WEB_ORIGIN === undefined || env.WEB_ORIGIN === '') return undefined;
  const raw = endpoint(env, 'WEB_ORIGIN', ['http:', 'https:']);
  const url = new URL(raw);
  if (url.origin !== raw) throw new Error('Invalid WEB_ORIGIN: expected an origin without path or credentials');
  return raw;
}
export function parseConfiguration(env: Environment, service: 'api' | 'worker') {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('Invalid NODE_ENV');
  const host = env.HOST ?? '0.0.0.0';
  if (!host.trim()) throw new Error('Invalid HOST');
  return {
    webOrigin: webOrigin(env),
    host, port: integer(env, service === 'api' ? 'API_PORT' : 'WORKER_PORT', service === 'api' ? 3000 : 3001),
    databaseUrl: endpoint(env, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: endpoint(env, 'REDIS_URL', ['redis:', 'rediss:']),
    admissionTimeoutMs: integer(env, 'ADMISSION_TIMEOUT_MS', 3000, 30000),
    databasePoolSize: integer(env, 'DATABASE_POOL_SIZE', 10, 100),
    retryPolicy: {
      maxAttempts: integer(env, 'ORDER_MAX_ATTEMPTS', 5, 100),
      baseMs: integer(env, 'ORDER_RETRY_BASE_MS', 1000, 60000),
      maxMs: integer(env, 'ORDER_RETRY_MAX_MS', 60000, 3600000),
    },
    dependencyTimeoutMs: integer(env, 'DEPENDENCY_TIMEOUT_MS', 2000, 30000),
  };
}
