import { saleKey } from './configuration.js';
import type { createRedisConnection } from '../index.js';
type Connection = ReturnType<typeof createRedisConnection>;
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 1000,
  maxMs: 60000,
};
export function retryDelay(
  policy: RetryPolicy,
  attempt: number,
  random = Math.random(),
) {
  const ceiling = Math.min(
    policy.maxMs,
    policy.baseMs * 2 ** Math.min(attempt - 1, 30),
  );
  return Math.max(1, Math.floor(ceiling / 2 + (random * ceiling) / 2));
}
const claim = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local state = raw and cjson.decode(raw) or {attempts=0, nextAt=0, version=1}
if state.version ~= 1 then return redis.error_reply('RETRY_SCHEMA operator investigation required') end
local time = redis.call('TIME'); local now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if state.completed or state.nextAt > now or state.attempts >= tonumber(ARGV[2]) then return 0 end
state.attempts = state.attempts+1
state.nextAt = now+tonumber(ARGV[3])
state.reason = 'attempt_interrupted'
state.exhausted = state.attempts >= tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
redis.call('ZADD', KEYS[2], state.nextAt, ARGV[1])
return state.attempts
`;
export async function claimAttempt(
  redis: Connection,
  saleId: string,
  id: string,
  policy: RetryPolicy,
) {
  const prefix = saleKey(saleId);
  const attempt = Number(
    await redis.sendCommand([
      'EVAL',
      claim,
      '2',
      `${prefix}:retries`,
      `${prefix}:retry_due`,
      id,
      String(policy.maxAttempts),
      '60000',
    ]),
  );
  return attempt;
}
export async function delayAttempt(
  redis: Connection,
  saleId: string,
  id: string,
  attempt: number,
  policy: RetryPolicy,
) {
  const script = `
local raw = redis.call('HGET', KEYS[1], ARGV[1]); if not raw then return 0 end
local state = cjson.decode(raw)
if state.attempts ~= tonumber(ARGV[2]) then return 0 end
local time = redis.call('TIME'); local now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
state.nextAt = now+tonumber(ARGV[3]); state.reason = 'dependency_unavailable'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
redis.call('ZADD', KEYS[2], state.nextAt, ARGV[1]); return 1`;
  const prefix = saleKey(saleId);
  await redis.sendCommand([
    'EVAL',
    script,
    '2',
    `${prefix}:retries`,
    `${prefix}:retry_due`,
    id,
    String(attempt),
    String(retryDelay(policy, attempt)),
  ]);
}
/** Only exhausted work can be rearmed. Concurrent/repeated replay cannot reset an active budget. */
export async function replayOrder(
  redis: Connection,
  saleId: string,
  id: string,
) {
  const prefix = saleKey(saleId);
  const result = await redis.sendCommand([
    'EVAL',
    `
redis.call('HINCRBY', KEYS[4], 'replay_checkpoint', 1)
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return redis.error_reply('Quarantined work requires investigation') end
local raw = redis.call('HGET', KEYS[1], ARGV[1]); if not raw then return 0 end
local state = cjson.decode(raw)
local time = redis.call('TIME'); local now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if state.version ~= 1 then return redis.error_reply('RETRY_SCHEMA') end
if state.completed or not state.exhausted or state.nextAt > now then return 0 end
state.attempts=0; state.exhausted=false; state.nextAt=0; state.reason='operator_replay'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state)); redis.call('ZADD', KEYS[2], 0, ARGV[1]); return 1
`,
    '4',
    `${prefix}:retries`,
    `${prefix}:retry_due`,
    `${prefix}:quarantine`,
    prefix,
    id,
  ]);
  return Number(result);
}

export async function finishAttempt(
  redis: Connection,
  saleId: string,
  id: string,
  attempt: number,
) {
  const prefix = saleKey(saleId);
  await redis.sendCommand([
    'EVAL',
    `
local raw = redis.call('HGET', KEYS[1], ARGV[1]); if not raw then return 0 end
local state = cjson.decode(raw)
if state.attempts ~= tonumber(ARGV[2]) then return 0 end
state.completed=true; state.exhausted=false; state.reason='completed'; state.nextAt=0
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state)); redis.call('ZREM', KEYS[2], ARGV[1]); return 1
`,
    '2',
    `${prefix}:retries`,
    `${prefix}:retry_due`,
    id,
    String(attempt),
  ]);
}
