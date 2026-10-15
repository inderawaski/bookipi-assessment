export interface AdmissionConfiguration { id: string; startsAt: string; endsAt: string; initialStock: number }
interface RedisCommands { sendCommand(args: string[]): Promise<unknown> }
export function saleKey(id: string) { return `sale:{${Buffer.from(id).toString('hex')}}:admission`; }
function values(sale: AdmissionConfiguration) {
  return [String(Date.parse(sale.startsAt)), String(Date.parse(sale.endsAt)), String(sale.initialStock)];
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
-- Force a write on this connection so WAITAOF also covers an idempotent retry.
redis.call('HSET', KEYS[1], 'configuration_version', '1')
return 1
`;
export async function initializeAdmission(redis: RedisCommands, sale: AdmissionConfiguration) {
  await redis.sendCommand(['EVAL', configure, '1', saleKey(sale.id), ...values(sale)]);
  const durability = await redis.sendCommand(['WAITAOF', '1', '0', '2000']);
  if (!Array.isArray(durability) || durability[0] !== 1) throw new Error('Admission configuration durability unconfirmed');
}
export async function assertAdmissionConfiguration(redis: RedisCommands, sale: AdmissionConfiguration) {
  const actual = await redis.sendCommand(['HMGET', saleKey(sale.id), 'starts_at', 'ends_at', 'initial_stock', 'remaining_stock']);
  const expected = values(sale);
  if (!Array.isArray(actual) || expected.some((value, index) => actual[index] !== value) || typeof actual[3] !== 'string' || !/^\d+$/.test(actual[3]) || Number(actual[3]) > sale.initialStock) {
    throw new Error('Admission configuration missing or inconsistent; run sale:configure or repair');
  }
}
