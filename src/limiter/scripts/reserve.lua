-- Atomic multi-dimensional admission. common.lua is prepended by the loader.
-- KEYS: operation, sorted distinct buckets (one tenant slot).
-- ARGV: fingerprint, owner, retention_ms, settlement_horizon_ms, count,
-- then six values per bucket: capacity, rate, cost, policy hash, unit, token flag.
-- Codes: 0 allow, 1 reject, 2 impossible, 3 duplicate, 4 conflict.
local fingerprint = bounded_text(ARGV[1], 128, 'INVALID_FINGERPRINT')
local owner = bounded_text(ARGV[2], 128, 'INVALID_OWNER')
local retention = integer(ARGV[3], 1, 86400000, 'INVALID_RETENTION')
local horizon = integer(ARGV[4], 1, retention, 'INVALID_SETTLEMENT_HORIZON')
local count = integer(ARGV[5], 1, 8, 'INVALID_COUNT')
validate_keys(count)
local states = {}
for i = 1, count do states[i] = bucket_spec(i) end

local op = read_operation(KEYS[1])
if op then
  if op.fingerprint ~= fingerprint then return {4} end
  return {3, op.status == 'SETTLED' and 2 or 1}
end

local now = now_ms()
local settle_by = safe(now + horizon)
local retain_until = safe(now + retention)
local max_wait, failing, impossible = 0, 0, 0
for i, state in ipairs(states) do
  read_bucket(state, now)
  refill(state, now)
  if state.cost > state.capacity then
    impossible = i
  elseif state.balance < state.cost then
    local deficit = safe(safe((state.cost - state.balance) * 1000) - state.remainder)
    local wait = safe(math.max(0, state.last_ms - now) + ceil_div(deficit, state.rate))
    if wait > max_wait then max_wait, failing = wait, i end
  end
end
if impossible > 0 then return {2, impossible} end
if failing > 0 then return {1, max_wait, failing} end

-- Prepare every arithmetic result and serialized field before any write.
local reply = {0, now, count}
local fields = {'schema', '1', 'fingerprint', fingerprint, 'owner', owner,
  'status', 'RESERVED', 'created_ms', decimal(now), 'settle_by_ms', decimal(settle_by),
  'retain_until_ms', decimal(retain_until), 'bucket_count', decimal(count)}
for i, state in ipairs(states) do
  state.balance = state.balance - state.cost
  prepare_bucket(state, now)
  table.insert(reply, state.balance)
  table.insert(fields, 'spec_' .. i)
  table.insert(fields, state.spec)
end

-- Redis prevents interleaving, but does not roll back a write-phase error.
for _, state in ipairs(states) do write_bucket(state) end
redis.call('HSET', KEYS[1], unpack(fields))
redis.call('PEXPIREAT', KEYS[1], decimal(retain_until))
return reply
