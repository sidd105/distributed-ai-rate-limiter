-- Fixed source prepended to each script. All helpers run before the write phase,
-- except write_bucket. Integers stay within the exact range of Lua doubles.
local MAX_SAFE = 9007199254740991
local MAX_CREDITS = 1000000000
local MAX_DEBT = 1000000000000

local function invalid(code)
  error('INTEGRITY ' .. code, 0)
end

local function integer(value, minimum, maximum, code)
  if type(value) ~= 'number' and type(value) ~= 'string' then invalid(code) end
  local n = tonumber(value)
  if not n or n ~= n or n < minimum or n > maximum or n ~= math.floor(n) then
    invalid(code)
  end
  return n
end

local function bounded_text(value, maximum, code)
  if type(value) ~= 'string' or #value == 0 or #value > maximum then invalid(code) end
  return value
end

local function safe(value)
  return integer(value, -MAX_SAFE, MAX_SAFE, 'NUMERIC_OVERFLOW')
end

local function decimal(value)
  return string.format('%.0f', value)
end

local function ceil_div(n, d)
  local q = math.floor(n / d)
  return q * d < n and q + 1 or q
end

local function now_ms()
  local time = redis.call('TIME')
  return integer(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000),
    0, MAX_SAFE, 'INVALID_CLOCK')
end

local function validate_keys(count)
  if #KEYS ~= count + 1 or #ARGV ~= 5 + count * 6 then invalid('INVALID_ARGUMENT_COUNT') end
  local tag = nil
  local seen = {}
  for _, key in ipairs(KEYS) do
    bounded_text(key, 512, 'INVALID_KEY')
    local current = string.match(key, '{([^{}]+)}')
    if not current or (tag and tag ~= current) or seen[key] then invalid('INVALID_KEY_SET') end
    tag = current
    seen[key] = true
  end
end

local function bucket_spec(i)
  local base = 5 + (i - 1) * 6
  local state = {
    key = KEYS[i + 1],
    capacity = integer(ARGV[base + 1], 1, MAX_CREDITS, 'INVALID_CAPACITY'),
    rate = integer(ARGV[base + 2], 1, MAX_CREDITS, 'INVALID_RATE'),
    cost = integer(ARGV[base + 3], 1, MAX_CREDITS, 'INVALID_COST'),
    policy_hash = bounded_text(ARGV[base + 4], 128, 'INVALID_POLICY'),
    unit = ARGV[base + 5],
    is_token = integer(ARGV[base + 6], 0, 1, 'INVALID_UNIT'),
  }
  if (state.unit ~= 'requests' and state.unit ~= 'tokens') or
     (state.unit == 'tokens') ~= (state.is_token == 1) then invalid('INVALID_UNIT') end
  state.spec = state.key .. '|' .. decimal(state.capacity) .. '|' .. decimal(state.rate) ..
    '|' .. decimal(state.cost) .. '|' .. state.policy_hash .. '|' .. state.unit .. '|' .. state.is_token
  return state
end

local function read_operation(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return nil end
  if kind ~= 'hash' then invalid('WRONG_OPERATION_TYPE') end
  local v = redis.call('HMGET', key, 'schema', 'fingerprint', 'owner', 'status',
    'created_ms', 'settle_by_ms', 'retain_until_ms', 'bucket_count', 'actual_tokens', 'outcome')
  if v[1] ~= '1' or (v[4] ~= 'RESERVED' and v[4] ~= 'SETTLED') then invalid('CORRUPT_OPERATION') end
  local op = {
    fingerprint = bounded_text(v[2], 128, 'CORRUPT_OPERATION'),
    owner = bounded_text(v[3], 128, 'CORRUPT_OPERATION'),
    status = v[4],
    created = integer(v[5], 0, MAX_SAFE, 'CORRUPT_OPERATION'),
    settle_by = integer(v[6], 0, MAX_SAFE, 'CORRUPT_OPERATION'),
    retain_until = integer(v[7], 0, MAX_SAFE, 'CORRUPT_OPERATION'),
    count = integer(v[8], 1, 8, 'CORRUPT_OPERATION'),
    specs = {},
  }
  if op.settle_by < op.created or op.retain_until < op.settle_by then invalid('CORRUPT_OPERATION') end
  for i = 1, op.count do
    op.specs[i] = bounded_text(redis.call('HGET', key, 'spec_' .. i), 1024, 'CORRUPT_OPERATION')
  end
  if op.status == 'SETTLED' then
    op.actual = integer(v[9], 0, MAX_DEBT, 'CORRUPT_OPERATION')
    op.outcome = bounded_text(v[10], 32, 'CORRUPT_OPERATION')
  end
  return op
end

local function read_bucket(state, now)
  local kind = redis.call('TYPE', state.key).ok
  if kind ~= 'none' and kind ~= 'hash' then invalid('WRONG_BUCKET_TYPE') end
  state.balance, state.last_ms, state.remainder = state.capacity, now, 0
  if kind == 'hash' then
    local v = redis.call('HMGET', state.key, 'schema', 'policy_hash', 'balance', 'last_ms', 'remainder')
    if v[1] ~= '1' then invalid('CORRUPT_BUCKET') end
    if v[2] ~= state.policy_hash then invalid('POLICY_MISMATCH') end
    state.balance = integer(v[3], state.is_token == 1 and -MAX_DEBT or 0,
      state.capacity, 'CORRUPT_BALANCE')
    state.last_ms = integer(v[4], 0, MAX_SAFE, 'CORRUPT_TIMESTAMP')
    state.remainder = integer(v[5], 0, 999, 'CORRUPT_REMAINDER')
    if state.balance == state.capacity and state.remainder ~= 0 then invalid('CORRUPT_REMAINDER') end
  end
end

local function refill(state, now)
  local effective = math.max(now, state.last_ms)
  local need = math.max(0, safe(safe((state.capacity - state.balance) * 1000) - state.remainder))
  local dt = math.min(effective - state.last_ms, ceil_div(need, state.rate))
  local numerator = safe(safe(dt * state.rate) + state.remainder)
  state.balance = math.min(state.capacity, safe(state.balance + math.floor(numerator / 1000)))
  state.remainder = state.balance == state.capacity and 0 or numerator % 1000
  state.last_ms = effective
end

local function prepare_bucket(state, now)
  integer(state.balance, state.is_token == 1 and -MAX_DEBT or 0,
    state.capacity, 'NUMERIC_OVERFLOW')
  local need = math.max(0, safe(safe((state.capacity - state.balance) * 1000) - state.remainder))
  local gap = math.max(0, state.last_ms - now)
  state.ttl = integer(safe(gap + ceil_div(need, state.rate) + 1000), 1000, MAX_SAFE, 'INVALID_TTL')
  safe(now + state.ttl)
end

local function write_bucket(state)
  -- Include the schema even when settlement recreates a naturally expired key.
  redis.call('HSET', state.key, 'schema', '1', 'policy_hash', state.policy_hash,
    'balance', decimal(state.balance), 'last_ms', decimal(state.last_ms),
    'remainder', decimal(state.remainder))
  redis.call('PEXPIRE', state.key, decimal(state.ttl))
end
