/** Restart changes run_id; the persisted previous run cannot reopen admission. */
export const recoveryFence = `
local run = string.match(redis.call('INFO', 'server'), 'run_id:([^\\r\\n]+)')
if not run or redis.call('HGET', KEYS[1], 'recovered_run') ~= run then
  return redis.error_reply('ADMISSION_FENCED recovery required')
end
`;

export const confirmationScript = `
${recoveryFence}
for i = 1, 5 do
  if redis.call('PTTL', KEYS[i]) >= 0 then return redis.error_reply('ADMISSION_EXPIRING_STATE') end
end
if redis.call('HGET', KEYS[1], 'admission_fault') then return redis.error_reply('ADMISSION_FAULT') end
local request = redis.call('HGET', KEYS[2], ARGV[1])
if not request then return {} end
local raw = redis.call('HGET', KEYS[4], request)
if not raw or redis.call('HGET', KEYS[3], request) ~= ARGV[1] then return redis.error_reply('ADMISSION_ASSOCIATION') end
local record = cjson.decode(raw)
if record.identifier ~= ARGV[1] then return redis.error_reply('ADMISSION_ASSOCIATION') end
local entries = redis.call('XRANGE', KEYS[5], record.streamId, record.streamId)
if #entries ~= 1 then return redis.error_reply('ADMISSION_STREAM') end
local fields = {}
for i = 1, #entries[1][2], 2 do fields[entries[1][2][i]] = entries[1][2][i+1] end
if fields.identifier ~= ARGV[1] or fields.request_key ~= request or fields.sale_id ~= ARGV[2] or
   fields.admitted_at_ms ~= tostring(record.admittedAtMs) then return redis.error_reply('ADMISSION_STREAM') end
return {request, tostring(record.admittedAtMs), record.streamId}
`;

/** Operator/startup operation; all allocations remain retained, including completed orders. */
export const recoveryScript = `
local function fail()
  -- Missing pre-sale state must stay missing so configuration can safely resume.
  if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('HDEL', KEYS[1], 'recovered_run')
    redis.call('HSET', KEYS[1], 'recovery_diagnostic', 'invalid accounting/schema/association; inspect configuration, mappings, stream, retry metadata and durable orders')
  end
  return redis.error_reply('ADMISSION_RECOVERY invalid accounting/schema/association; inspect sale state and durable orders')
end
local run = string.match(redis.call('INFO', 'server'), 'run_id:([^\\r\\n]+)')
if redis.call('PTTL', KEYS[1]) >= 0 then return fail() end
redis.call('HDEL', KEYS[1], 'recovered_run')
if run ~= ARGV[1] or redis.call('HGET', KEYS[1], 'admission_fault') then return fail() end
if redis.call('HGET', KEYS[1], 'configuration_version') ~= '1' then return fail() end
if redis.call('HGET', KEYS[1], 'starts_at') ~= ARGV[4] or
   redis.call('HGET', KEYS[1], 'ends_at') ~= ARGV[5] or
   redis.call('HGET', KEYS[1], 'initial_stock') ~= ARGV[6] then return fail() end
for i = 1, 5 do
 local expected = i == 5 and 'stream' or 'hash'
 local actual = redis.call('TYPE', KEYS[i]).ok
 if actual ~= expected and (i == 1 or actual ~= 'none') then return fail() end
 if redis.call('PTTL', KEYS[i]) >= 0 then return fail() end
end
local completed = KEYS[1] .. ':completed'
local kind = redis.call('TYPE', completed).ok
if (kind ~= 'none' and kind ~= 'hash') or redis.call('PTTL', completed) >= 0 then return fail() end
local outcomes = KEYS[1] .. ':outcomes'
local outcomeKind = redis.call('TYPE', outcomes).ok
if (outcomeKind ~= 'none' and outcomeKind ~= 'hash') or redis.call('PTTL', outcomes) >= 0 then return fail() end
local outcomeEntries = redis.call('HGETALL', outcomes)
for i = 1, #outcomeEntries, 2 do
  local ok, outcome = pcall(cjson.decode, outcomeEntries[i+1])
  if not ok or type(outcome) ~= 'table' or type(outcome.identifier) ~= 'string' or
     redis.call('HEXISTS', KEYS[3], outcomeEntries[i]) == 1 or
     (outcome.reason ~= 'upcoming' and outcome.reason ~= 'ended' and outcome.reason ~= 'sold_out' and outcome.reason ~= 'already_placed') then return fail() end
  if outcome.reason == 'already_placed' and redis.call('HEXISTS', KEYS[2], outcome.identifier) == 0 then return fail() end
end
for _, suffix in ipairs({':retries', ':retry_due', ':quarantine'}) do
  local key = KEYS[1] .. suffix
  local expected = suffix == ':retry_due' and 'zset' or 'hash'
  local actual = redis.call('TYPE', key).ok
  if (actual ~= expected and actual ~= 'none') or redis.call('PTTL', key) >= 0 then return fail() end
end
for _, raw in ipairs(redis.call('HVALS', KEYS[1] .. ':retries')) do
 local ok, state = pcall(cjson.decode, raw)
 if not ok or type(state) ~= 'table' or state.version ~= 1 or
    type(state.attempts) ~= 'number' or state.attempts < 0 or state.attempts % 1 ~= 0 or
    type(state.nextAt) ~= 'number' or state.nextAt < 0 or state.nextAt % 1 ~= 0 or
    type(state.reason) ~= 'string' or type(state.exhausted) ~= 'boolean' or
    (state.completed ~= nil and type(state.completed) ~= 'boolean') then return fail() end
end
local initial = tonumber(redis.call('HGET', KEYS[1], 'initial_stock'))
local remainingRaw = redis.call('HGET', KEYS[1], 'remaining_stock')
if not remainingRaw or not string.match(remainingRaw, '^%d+$') then return fail() end
local remaining = tonumber(remainingRaw)
if not initial or not remaining or remaining < 0 or remaining > initial then return fail() end
local count = initial - remaining
for i = 2, 4 do if redis.call('HLEN', KEYS[i]) ~= count or redis.call('PTTL', KEYS[i]) >= 0 then return fail() end end
if redis.call('XLEN', KEYS[5]) > count then return fail() end
local records = redis.call('HGETALL', KEYS[4])
for i = 1, #records, 2 do
  local request = records[i]
  local ok, record = pcall(cjson.decode, records[i+1])
  if not ok or type(record) ~= 'table' or type(record.identifier) ~= 'string' or type(record.streamId) ~= 'string' or type(record.admittedAtMs) ~= 'number' or record.admittedAtMs % 1 ~= 0 or
     record.admittedAtMs < tonumber(redis.call('HGET', KEYS[1], 'starts_at')) or
     record.admittedAtMs >= tonumber(redis.call('HGET', KEYS[1], 'ends_at')) then return fail() end
  if redis.call('HGET', KEYS[2], record.identifier) ~= request or
     redis.call('HGET', KEYS[3], request) ~= record.identifier then return fail() end
  local entries = redis.call('XRANGE', KEYS[5], record.streamId, record.streamId)
  if #entries == 0 then
    -- Atomic script: a crash cannot split append from reservation replacement.
    local previousId = record.streamId
    record.streamId = redis.call('XADD', KEYS[5], '*', 'sale_id', ARGV[3], 'identifier', record.identifier,
      'request_key', request, 'admitted_at_ms', tostring(record.admittedAtMs))
    redis.call('HSET', KEYS[4], request, cjson.encode(record))
    local retry = redis.call('HGET', KEYS[1] .. ':retries', previousId)
    if retry then
      redis.call('HSET', KEYS[1] .. ':retries', record.streamId, retry)
      redis.call('HDEL', KEYS[1] .. ':retries', previousId)
      redis.call('ZREM', KEYS[1] .. ':retry_due', previousId)
      redis.call('ZADD', KEYS[1] .. ':retry_due', 0, record.streamId)
    end
    local quarantine = redis.call('HGET', KEYS[1] .. ':quarantine', previousId)
    if quarantine then
      redis.call('HSET', KEYS[1] .. ':quarantine', record.streamId, quarantine)
      redis.call('HDEL', KEYS[1] .. ':quarantine', previousId)
    end
    entries = redis.call('XRANGE', KEYS[5], record.streamId, record.streamId)
  end
  if #entries ~= 1 then return fail() end
  local fields = {}
  for j = 1, #entries[1][2], 2 do fields[entries[1][2][j]] = entries[1][2][j+1] end
  if fields.identifier ~= record.identifier or fields.request_key ~= request or fields.sale_id ~= ARGV[3] or
     fields.admitted_at_ms ~= tostring(record.admittedAtMs) then return fail() end
end
for _, order in ipairs(cjson.decode(ARGV[2])) do
  local request = redis.call('HGET', KEYS[2], order.identifier)
  if not request then return fail() end
  local record = cjson.decode(redis.call('HGET', KEYS[4], request))
  if record.admittedAtMs ~= order.admittedAtMs then return fail() end
  if order.orderId then redis.call('HSET', completed, order.identifier, order.orderId) end
end
if redis.call('XLEN', KEYS[5]) ~= count then return fail() end
redis.call('HDEL', KEYS[1], 'recovery_diagnostic')
redis.call('HSET', KEYS[1], 'recovered_run', run)
return 1
`;
