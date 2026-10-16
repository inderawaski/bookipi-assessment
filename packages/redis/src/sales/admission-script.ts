import { recoveryFence } from './state-scripts.js';
/** Pure window decision, shared with exact-timestamp Lua tests. */
export const admissionWindowPredicate = `
local function windowRejection(starts, ends, now)
  if now < starts then return 'upcoming' end
  if now >= ends then return 'ended' end
  return nil
end
`;

/** All keys share a sale hash tag. Only this script may write allocation state. */
export const admissionScript = `
${admissionWindowPredicate}
local function invalid(message) return redis.error_reply('ADMISSION_SCHEMA ' .. message) end
if #KEYS ~= 5 or #ARGV ~= 3 then return invalid('argument count') end
local identifier, request, sale = ARGV[1], ARGV[2], ARGV[3]
if #identifier == 0 or #identifier > 1024 or string.find(identifier, '%z') or
   #request == 0 or #request > 128 or string.find(request, '[^!-~]') or #sale == 0 then
  return invalid('arguments')
end
local prefix = 'sale:{' .. string.gsub(sale, '.', function(c) return string.format('%02x', string.byte(c)) end) .. '}:admission'
local suffixes = {'', ':identifiers', ':requests', ':reservations', ':stream'}
local types = {'hash', 'hash', 'hash', 'hash', 'stream'}
for i = 1, 5 do
  if KEYS[i] ~= prefix .. suffixes[i] then return invalid('key ownership or aliased keys') end
  for j = 1, i - 1 do if KEYS[i] == KEYS[j] then return invalid('aliased keys') end end
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= types[i] and (i == 1 or kind ~= 'none') then return invalid('key type') end
  if redis.call('PTTL', KEYS[i]) >= 0 then return invalid('expiring state') end
end
${recoveryFence}
if redis.call('HGET', KEYS[1], 'admission_fault') then return invalid('operator reconciliation required') end
local function integer(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local number = tonumber(value)
  if number > 9007199254740991 then return nil end
  return number
end
local starts = integer(redis.call('HGET', KEYS[1], 'starts_at'))
local ends = integer(redis.call('HGET', KEYS[1], 'ends_at'))
local initial = integer(redis.call('HGET', KEYS[1], 'initial_stock'))
local remaining = integer(redis.call('HGET', KEYS[1], 'remaining_stock'))
if not starts or not ends or starts >= ends or not initial or initial > 2147483647 or
   not remaining or remaining > initial or redis.call('HGET', KEYS[1], 'configuration_version') ~= '1' then
  return invalid('configuration')
end
for i = 2, 4 do
  if redis.call('HLEN', KEYS[i]) ~= initial - remaining then return invalid('allocation accounting') end
end
local function allocation(key)
  local raw = redis.call('HGET', KEYS[4], key)
  if not raw then return nil end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' or type(record.identifier) ~= 'string' or
     type(record.admittedAtMs) ~= 'number' or type(record.streamId) ~= 'string' or
     redis.call('HGET', KEYS[2], record.identifier) ~= key or
     redis.call('HGET', KEYS[3], key) ~= record.identifier then return nil end
  return record
end
-- An allocated request replays before duplicate/window/stock decisions.
local previous = redis.call('HGET', KEYS[3], request)
if previous then
  local record = allocation(request)
  if not record then return invalid('request association') end
  if previous ~= identifier then return {'rejected', 'idempotency_conflict'} end
  return {'reserved', request, tostring(record.admittedAtMs), record.streamId, 'replay'}
end
local outcomes = KEYS[1] .. ':outcomes'
local kind = redis.call('TYPE', outcomes).ok
if (kind ~= 'none' and kind ~= 'hash') or redis.call('PTTL', outcomes) >= 0 then return invalid('outcome schema') end
local prior = redis.call('HGET', outcomes, request)
if prior then
  local ok, outcome = pcall(cjson.decode, prior)
  if not ok or type(outcome) ~= 'table' or type(outcome.identifier) ~= 'string' then return invalid('outcome association') end
  if outcome.identifier ~= identifier then return {'rejected', 'idempotency_conflict'} end
  -- Rewriting establishes this socket's AOF offset for a replayed rejection.
  redis.call('HSET', outcomes, request, prior)
  if outcome.reason ~= 'already_placed' then
    if outcome.reason ~= 'upcoming' and outcome.reason ~= 'ended' and outcome.reason ~= 'sold_out' then return invalid('outcome reason') end
    return {'rejected', outcome.reason}
  end
  local record = allocation(redis.call('HGET', KEYS[2], identifier) or '')
  if not record then return invalid('duplicate association') end
  return {'already_placed', redis.call('HGET', KEYS[2], identifier), tostring(record.admittedAtMs), record.streamId}
end
local function remember(reason)
  redis.call('HSET', outcomes, request, cjson.encode({identifier=identifier, reason=reason}))
end
local existing = redis.call('HGET', KEYS[2], identifier)
if existing then
  local record = allocation(existing)
  if not record then return invalid('identifier association') end
  remember('already_placed')
  return {'already_placed', existing, tostring(record.admittedAtMs), record.streamId}
end
if redis.call('HEXISTS', KEYS[4], request) == 1 then return invalid('orphan reservation') end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window = windowRejection(starts, ends, now)
if window then remember(window); return {'rejected', window} end
if remaining == 0 then remember('sold_out'); return {'rejected', 'sold_out'} end
-- Validate stream exhaustion before mutation (XADD * cannot advance a maximal ID).
local last = redis.call('XREVRANGE', KEYS[5], '+', '-', 'COUNT', 1)
if #last > 0 and last[1][1] == '18446744073709551615-18446744073709551615' then
  return invalid('stream exhausted')
end
-- Lua has no rollback. A persistent latch also survives a partial mutation error.
-- Never clear a preexisting latch here; only operator reconciliation may do so.
redis.call('HSET', KEYS[1], 'admission_fault', request)
local ok, result = pcall(function()
  redis.call('HINCRBY', KEYS[1], 'remaining_stock', -1)
  redis.call('HSET', KEYS[2], identifier, request)
  redis.call('HSET', KEYS[3], request, identifier)
  local sequence = redis.call('XADD', KEYS[5], '*', 'sale_id', sale,
    'identifier', identifier, 'request_key', request, 'admitted_at_ms', tostring(now))
  redis.call('HSET', KEYS[4], request, cjson.encode({identifier=identifier, admittedAtMs=now, streamId=sequence}))
  redis.call('HDEL', KEYS[1], 'admission_fault')
  return {'reserved', request, tostring(now), sequence, 'new'}
end)
if not ok then return redis.error_reply('ADMISSION_UNCERTAIN operator reconciliation required') end
return result
`;
