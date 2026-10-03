-- Idempotent reconciliation; common.lua is prepended by the loader.
-- ARGV: fingerprint, owner, actual milli-tokens, outcome, count, bucket specs.
-- Codes: 0 settled, 1 replay, 2 conflict, 3 unknown, 4 expired.
local fingerprint = bounded_text(ARGV[1], 128, 'INVALID_FINGERPRINT')
local owner = bounded_text(ARGV[2], 128, 'INVALID_OWNER')
local actual = integer(ARGV[3], 0, MAX_DEBT, 'INVALID_ACTUAL_USAGE')
local outcome = bounded_text(ARGV[4], 32, 'INVALID_OUTCOME')
if not string.match(outcome, '^[A-Z_]+$') then invalid('INVALID_OUTCOME') end
local count = integer(ARGV[5], 1, 8, 'INVALID_COUNT')
validate_keys(count)
local states = {}
for i = 1, count do states[i] = bucket_spec(i) end

local op = read_operation(KEYS[1])
if not op then return {3} end
if op.fingerprint ~= fingerprint or op.owner ~= owner or op.count ~= count then return {2} end
for i, state in ipairs(states) do
  if state.spec ~= op.specs[i] then return {2} end
end
if op.status == 'SETTLED' then
  if op.actual == actual and op.outcome == outcome then return {1} end
  return {2}
end
local now = now_ms()
if now > op.settle_by then return {4} end

local refund, excess = 0, 0
for _, state in ipairs(states) do
  -- Validate all keys, including request buckets, before touching token balances.
  read_bucket(state, now)
  if state.is_token == 1 then
    refill(state, now)
    local delta = state.cost - actual
    state.balance = math.min(state.capacity, safe(state.balance + delta))
    if state.balance == state.capacity then state.remainder = 0 end
    prepare_bucket(state, now)
    -- Logical requested delta, not sum across nested budgets nor applied credit.
    if delta >= 0 then refund = math.max(refund, delta)
    else excess = math.max(excess, -delta) end
  end
end

for _, state in ipairs(states) do
  if state.is_token == 1 then write_bucket(state) end
end
redis.call('HSET', KEYS[1], 'status', 'SETTLED', 'actual_tokens', decimal(actual),
  'outcome', outcome, 'settled_ms', decimal(now))
return {0, refund, excess}
