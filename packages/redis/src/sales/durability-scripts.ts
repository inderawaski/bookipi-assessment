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
-- A fresh write advances THIS client's offset past the reservation and stream.
redis.call('HINCRBY', KEYS[1], 'confirmation_checkpoint', 1)
return {request, tostring(record.admittedAtMs), record.streamId}
`;

/** Operator/startup operation; all allocations remain retained, including completed orders. */
export const recoveryScript = `
local function fail() return redis.error_reply('ADMISSION_RECOVERY invalid accounting; operator repair required') end
local run = string.match(redis.call('INFO', 'server'), 'run_id:([^\\r\\n]+)')
if redis.call('PTTL', KEYS[1]) >= 0 then return fail() end
if run ~= ARGV[1] or redis.call('HGET', KEYS[1], 'admission_fault') then return fail() end
redis.call('HDEL', KEYS[1], 'recovered_run')
local initial = tonumber(redis.call('HGET', KEYS[1], 'initial_stock'))
local remaining = tonumber(redis.call('HGET', KEYS[1], 'remaining_stock'))
if not initial or not remaining or remaining < 0 or remaining > initial then return fail() end
local count = initial - remaining
for i = 2, 4 do if redis.call('HLEN', KEYS[i]) ~= count or redis.call('PTTL', KEYS[i]) >= 0 then return fail() end end
if redis.call('XLEN', KEYS[5]) ~= count or redis.call('PTTL', KEYS[5]) >= 0 then return fail() end
local records = redis.call('HGETALL', KEYS[4])
for i = 1, #records, 2 do
  local request, record = records[i], cjson.decode(records[i+1])
  if redis.call('HGET', KEYS[2], record.identifier) ~= request or
     redis.call('HGET', KEYS[3], request) ~= record.identifier then return fail() end
  local entries = redis.call('XRANGE', KEYS[5], record.streamId, record.streamId)
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
end
redis.call('HSET', KEYS[1], 'recovered_run', run)
redis.call('HINCRBY', KEYS[1], 'confirmation_checkpoint', 1)
return 1
`;
