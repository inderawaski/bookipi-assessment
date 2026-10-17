import { configurationRevisionKey } from './configuration-cache.js';
export interface AdmissionConfiguration {
  id: string;
  startsAt: string;
  endsAt: string;
  initialStock: number;
}
interface RedisCommands {
  sendCommand(args: string[]): Promise<unknown>;
}
export function saleKey(id: string) {
  return `sale:{${Buffer.from(id).toString('hex')}}:admission`;
}
function values(sale: AdmissionConfiguration) {
  return [
    String(Date.parse(sale.startsAt)),
    String(Date.parse(sale.endsAt)),
    String(sale.initialStock),
  ];
}
const configure = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'starts_at') ~= ARGV[1] or
     redis.call('HGET', KEYS[1], 'ends_at') ~= ARGV[2] or
     redis.call('HGET', KEYS[1], 'initial_stock') ~= ARGV[3] or
     not redis.call('HGET', KEYS[1], 'remaining_stock') then
    return redis.error_reply('Conflicting or incomplete admission configuration')
  end
else
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  if now >= tonumber(ARGV[1]) then return redis.error_reply('Missing admission state after opening; operator repair required') end
  redis.call('HSET', KEYS[1], 'starts_at', ARGV[1], 'ends_at', ARGV[2], 'initial_stock', ARGV[3], 'remaining_stock', ARGV[3])
end
-- Record the schema version on both fresh initialization and idempotent retry.
redis.call('HSET', KEYS[1], 'configuration_version', '1')
-- Invalidate metadata snapshots after configuration, including an idempotent retry.
redis.call('INCR', KEYS[2])
return 1
`;
export async function initializeAdmission(
  redis: RedisCommands,
  sale: AdmissionConfiguration,
) {
  await redis.sendCommand([
    'EVAL',
    configure,
    '2',
    saleKey(sale.id),
    configurationRevisionKey,
    ...values(sale),
  ]);
}
export async function assertAdmissionConfiguration(
  redis: RedisCommands,
  sale: AdmissionConfiguration,
) {
  const actual = await redis.sendCommand([
    'HMGET',
    saleKey(sale.id),
    'starts_at',
    'ends_at',
    'initial_stock',
    'remaining_stock',
  ]);
  const expected = values(sale);
  if (
    !Array.isArray(actual) ||
    expected.some((value, index) => actual[index] !== value) ||
    typeof actual[3] !== 'string' ||
    !/^\d+$/.test(actual[3]) ||
    Number(actual[3]) > sale.initialStock
  ) {
    throw new Error(
      'Admission configuration missing or inconsistent; run sale:configure or repair',
    );
  }
}

/** Read immutable fields already preloaded for Lua; absence permits a metadata fallback. */
export async function readAdmissionConfiguration(
  redis: RedisCommands,
  id: string,
): Promise<AdmissionConfiguration | undefined> {
  const fields = await redis.sendCommand([
    'HMGET',
    saleKey(id),
    'starts_at',
    'ends_at',
    'initial_stock',
    'configuration_version',
  ]);
  if (!Array.isArray(fields) || fields.length !== 4)
    throw new Error('Invalid sale configuration reply');
  if (fields.every((value) => value === null)) return undefined;
  const [starts, ends, stock, version] = fields;
  const integer = (value: unknown) =>
    typeof value === 'string' &&
    /^(0|[1-9]\d*)$/.test(value) &&
    Number.isSafeInteger(Number(value));
  if (
    !integer(starts) ||
    !integer(ends) ||
    !integer(stock) ||
    version !== '1' ||
    Number(starts) >= Number(ends) ||
    Number(stock) > 2147483647 ||
    Number(ends) > 8640000000000000
  )
    throw new Error('Invalid cached sale configuration');
  return {
    id,
    startsAt: new Date(Number(starts)).toISOString(),
    endsAt: new Date(Number(ends)).toISOString(),
    initialStock: Number(stock),
  };
}
