import type { AdmissionConfiguration } from './configuration.js';

interface RedisCommands { sendCommand(args: string[]): Promise<unknown> }
export const configurationRevisionKey = 'sales:configuration-revision';
const epoch = `
local run = string.match(redis.call('INFO', 'server'), 'run_id:([^\\r\\n]+)')
if not run then return redis.error_reply('Missing Redis run ID') end
local revision = run .. ':' .. (redis.call('GET', KEYS[1]) or '0')
`;
const read = `
${epoch}
local cached = redis.call('GET', KEYS[2])
return {revision, cached or ''}
`;
function decode(raw: string): { revision: string; sales: AdmissionConfiguration[] } {
  const cached = JSON.parse(raw) as { revision?: unknown; sales?: unknown };
  if (!cached || typeof cached.revision !== 'string' || !Array.isArray(cached.sales) ||
    cached.sales.some(sale => !sale || typeof sale.id !== 'string' || !sale.id ||
      typeof sale.startsAt !== 'string' || typeof sale.endsAt !== 'string' ||
      !Number.isFinite(Date.parse(sale.startsAt)) || !Number.isFinite(Date.parse(sale.endsAt)) ||
      Date.parse(sale.startsAt) >= Date.parse(sale.endsAt) || !Number.isInteger(sale.initialStock) ||
      sale.initialStock < 0 || sale.initialStock > 2147483647)) throw new Error('Invalid configuration cache payload');
  return cached as { revision: string; sales: AdmissionConfiguration[] };
}
const publish = `
${epoch}
if revision ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;
/** Immutable metadata only. Loading this cache never initializes stock or clears a fence. */
export async function cachedSaleConfigurations(redis: RedisCommands, scope: string,
  load: () => Promise<AdmissionConfiguration[]>, refresh = false): Promise<AdmissionConfiguration[]> {
  const key = `sales:configuration-cache:${Buffer.from(scope).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await redis.sendCommand(['EVAL', read, '2', configurationRevisionKey, key]);
    if (!Array.isArray(reply) || typeof reply[0] !== 'string' || typeof reply[1] !== 'string') throw new Error('Invalid configuration cache reply');
    const [revision, raw] = reply;
    if (raw && !refresh) {
      const cached = decode(raw);
      if (cached.revision === revision) return cached.sales;
    }
    const sales = await load();
    // A configuration published while the DB snapshot was loading invalidates it.
    if (await redis.sendCommand(['EVAL', publish, '2', configurationRevisionKey, key, revision,
      JSON.stringify({ revision, sales })]) === 1) return sales;
  }
  throw new Error('Sale configuration changed while loading cache; retry');
}
