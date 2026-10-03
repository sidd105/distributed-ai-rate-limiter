import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/limiter/limiter.js';
import { KeyFactory } from '../../src/limiter/keys.js';
import type { ReservationInput, ReserveResult } from '../../src/limiter/types.js';
import { redisFixture } from '../fixtures/redis.js';

let f: Awaited<ReturnType<typeof redisFixture>>;
beforeEach(async () => {
  f = await redisFixture(2);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});

function input(key = 'tokens', capacity = 10, rate = 0.001, cost = 1): ReservationInput {
  return {
    tenantId: 'review',
    userId: 'user',
    idempotencyKey: randomUUID(),
    fingerprint: 'semantic-request',
    buckets: [{ key, capacity, refillRate: rate, cost, unit: 'tokens' }],
  };
}
function allowed(r: ReserveResult) {
  if (r.status !== 'allowed') throw new Error(`Expected admission, got ${r.status}`);
  return r;
}

describe('architecture review regressions against real Redis', () => {
  it('reconstructs complete metadata after natural expiry and supports another instance', async () => {
    const request = input('expiry', 10, 1000);
    const r = allowed(await f.limiters[0]!.reserve(request));
    const key = r.handle.buckets[0]!.redisKey;
    const raw = f.clients[0]!.rawClient();
    await delay((await raw.pTTL(key)) + 80);
    expect(await raw.exists(key)).toBe(0);
    expect(await f.limiters[1]!.settle(r.handle, 1, 'COMPLETED')).toMatchObject({
      status: 'settled',
    });
    expect(await raw.hGetAll(key)).toMatchObject({
      schema: '1',
      policy_hash: r.handle.buckets[0]!.policyHash,
    });
    expect(
      (await f.limiters[0]!.reserve({ ...request, idempotencyKey: randomUUID() })).status,
    ).toBe('allowed');
  });

  it('retains the clock gap in TTL after admission and settlement into debt', async () => {
    const request = input('clock', 10, 1000);
    const first = allowed(await f.limiters[0]!.reserve(request));
    const key = first.handle.buckets[0]!.redisKey;
    const raw = f.clients[0]!.rawClient();
    await raw.hSet(key, 'last_ms', first.handle.createdAtMs + 60_000);
    const second = allowed(
      await f.limiters[1]!.reserve({ ...request, idempotencyKey: randomUUID() }),
    );
    expect(await raw.pTTL(key)).toBeGreaterThan(59_000);
    await f.limiters[0]!.settle(second.handle, 30, 'COMPLETED');
    expect(await raw.pTTL(key)).toBeGreaterThan(59_000);
    expect(Number(await raw.hGet(key, 'balance'))).toBe(-21_000);
    expect(
      (await f.limiters[1]!.reserve({ ...request, idempotencyKey: randomUUID() })).status,
    ).toBe('rejected');
  });

  it.each([
    ['balance', '1e100'],
    ['balance', 'NaN'],
    ['balance', '-1000000000001'],
    ['balance', '10001'],
    ['last_ms', 'Infinity'],
    ['remainder', '0.5'],
  ])('rejects corrupt %s=%s before changing any dimension', async (field, value) => {
    const request = input();
    request.buckets.push({ ...request.buckets[0]!, key: 'second' });
    const first = allowed(await f.limiters[0]!.reserve(request));
    const [valid, corrupt] = first.handle.buckets;
    const raw = f.clients[0]!.rawClient();
    await raw.hSet(corrupt!.redisKey, field, value);
    const before = await raw.hGetAll(valid!.redisKey);
    await expect(
      f.limiters[1]!.reserve({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('INTEGRITY');
    expect(await raw.hGetAll(valid!.redisKey)).toEqual(before);
    expect(await f.clients[1]!.ping()).toBe(false);
  });

  it('preflights malformed retention rather than leaving a partial operation/debit', async () => {
    const tag = `{review-${randomUUID()}}`;
    const keys = [`rl:${tag}:op`, `rl:${tag}:bucket`];
    await expect(
      f.clients[0]!.execute('reserve', keys, [
        'fingerprint',
        'owner',
        'bad',
        '600000',
        '1',
        '10000',
        '1',
        '1000',
        'policy',
        'tokens',
        '1',
      ]),
    ).rejects.toThrow('INVALID_RETENTION');
    expect(await f.clients[1]!.rawClient().exists(keys)).toBe(0);
  });

  it.each(['duplicate', 'cross-slot', 'fractional-cost'])(
    'rejects %s key/argument contracts',
    async (mode) => {
      const tag = `{review-${randomUUID()}}`;
      let keys = [`rl:${tag}:op`, `rl:${tag}:bucket`];
      const args = [
        'fingerprint',
        'owner',
        '86400000',
        '600000',
        '1',
        '10000',
        '1',
        '1000',
        'policy',
        'tokens',
        '1',
      ];
      if (mode === 'duplicate') keys = [keys[0]!, keys[0]!];
      if (mode === 'cross-slot') keys[1] = `rl:{other-${randomUUID()}}:bucket`;
      if (mode === 'fractional-cost') args[7] = '0.5';
      await expect(f.clients[0]!.execute('reserve', keys, args)).rejects.toThrow('INTEGRITY');
      expect(await f.clients[1]!.rawClient().exists(keys)).toBe(0);
    },
  );

  it('preflights cumulative debt overflow across all token buckets', async () => {
    const request = input();
    request.buckets.push({ ...request.buckets[0]!, key: 'second' });
    const first = allowed(await f.limiters[0]!.reserve(request));
    const [valid, corrupt] = first.handle.buckets;
    const raw = f.clients[0]!.rawClient();
    await raw.hSet(corrupt!.redisKey, {
      balance: '-1000000000000',
      last_ms: String(first.handle.createdAtMs + 60_000),
    });
    const before = await raw.hGetAll(valid!.redisKey);
    await expect(f.limiters[1]!.settle(first.handle, 1_000_000_000, 'COMPLETED')).rejects.toThrow(
      'NUMERIC_OVERFLOW',
    );
    expect(await raw.hGetAll(valid!.redisKey)).toEqual(before);
    expect(await raw.hGet(first.handle.operationKey, 'status')).toBe('RESERVED');
  });

  it('rejects partial operation records instead of interpreting them as pending work', async () => {
    const request = input();
    const first = allowed(await f.limiters[0]!.reserve(request));
    await f.clients[0]!.rawClient().hDel(first.handle.operationKey, 'status');
    await expect(f.limiters[1]!.reserve(request)).rejects.toThrow('CORRUPT_OPERATION');
  });

  it('isolates demo keys and operation IDs from protected policy state', async () => {
    const demo = new RateLimiter(f.clients[0]!, f.secret, f.telemetry, 'demo');
    const request = input('req:tenant', 1, 0.001);
    const demoResult = allowed(await demo.reserve(request));
    const protectedResult = allowed(
      await f.limiters[1]!.reserve({
        ...request,
        buckets: [{ key: 'req:tenant', capacity: 100, refillRate: 10, cost: 2, unit: 'requests' }],
      }),
    );
    expect(demoResult.handle.operationKey).not.toBe(protectedResult.handle.operationKey);
    expect(demoResult.handle.buckets[0]!.redisKey).not.toBe(
      protectedResult.handle.buckets[0]!.redisKey,
    );
    expect(protectedResult.remaining).toEqual([98]);
  });

  it('does not delete unrelated Redis keys during fixture cleanup', async () => {
    const sentinel = `review-sentinel:${randomUUID()}`;
    const raw = f.clients[0]!.rawClient();
    await raw.set(sentinel, 'keep');
    const other = await redisFixture(1);
    try {
      await other.limiters[0]!.reserve(input());
    } finally {
      await other.close();
    }
    expect(await raw.get(sentinel)).toBe('keep');
    await raw.del(sentinel);
  });

  it('settles once under a duplicate storm and does not overwrite concurrent debits', async () => {
    const request = input('concurrent-refund', 10, 0.001, 5);
    const first = allowed(await f.limiters[0]!.reserve(request));
    const raw = f.clients[0]!.rawClient();
    await raw.hSet(first.handle.buckets[0]!.redisKey, 'last_ms', first.handle.createdAtMs + 60_000);
    const refunds = Array.from({ length: 50 }, (_, i) =>
      f.limiters[i % 2]!.settle(first.handle, 3, 'COMPLETED'),
    );
    const spends = Array.from({ length: 20 }, (_, i) =>
      f.limiters[i % 2]!.reserve(input('concurrent-refund', 10, 0.001)),
    );
    const [settlements, admissions] = await Promise.all([
      Promise.all(refunds),
      Promise.all(spends),
    ]);
    expect(settlements.filter((r) => r.status === 'settled')).toHaveLength(1);
    expect(settlements.filter((r) => r.status === 'already_settled')).toHaveLength(49);
    const count = admissions.filter((r) => r.status === 'allowed').length;
    expect(count).toBeLessThanOrEqual(7);
    expect(Number(await raw.hGet(first.handle.buckets[0]!.redisKey, 'balance'))).toBe(
      (7 - count) * 1000,
    );
    expect(await f.limiters[1]!.settle(first.handle, 2, 'COMPLETED')).toEqual({
      status: 'conflict',
    });
  });

  it('retains known excess debt and never refunds a missing or expired operation', async () => {
    const first = allowed(await f.limiters[0]!.reserve(input('debt', 10, 0.001, 5)));
    const raw = f.clients[0]!.rawClient();
    await raw.hSet(first.handle.buckets[0]!.redisKey, 'last_ms', first.handle.createdAtMs + 60_000);
    await f.limiters[1]!.settle(first.handle, 20, 'COMPLETED');
    expect(Number(await raw.hGet(first.handle.buckets[0]!.redisKey, 'balance'))).toBe(-10_000);
    expect((await f.limiters[0]!.reserve(input('debt'))).status).toBe('rejected');
    await raw.del(first.handle.operationKey);
    expect(await f.limiters[1]!.settle(first.handle, 0, 'COMPLETED')).toEqual({
      status: 'unknown',
    });
    expect(Number(await raw.hGet(first.handle.buckets[0]!.redisKey, 'balance'))).toBe(-10_000);
    const late = allowed(await f.limiters[0]!.reserve(input('late')));
    await raw.hSet(late.handle.operationKey, { created_ms: '0', settle_by_ms: '1' });
    expect(await f.limiters[1]!.settle(late.handle, 0, 'COMPLETED')).toEqual({ status: 'expired' });
  });

  it('treats a lost admission reply as ambiguous and never grants a duplicate permit', async () => {
    const request = input('lost-reply');
    const execute = f.clients[0]!.execute.bind(f.clients[0]);
    vi.spyOn(f.clients[0]!, 'execute').mockImplementationOnce(async (...args) => {
      await execute(...args); // Real Redis commit, followed by transport failure.
      throw new Error('lost reply');
    });
    await expect(f.limiters[0]!.reserve(request)).rejects.toThrow('lost reply');
    expect(await f.limiters[1]!.reserve(request)).toMatchObject({ status: 'duplicate' });
    const key = new KeyFactory(f.secret).bucket('review', 'lost-reply');
    expect(Number(await f.clients[1]!.rawClient().hGet(key, 'balance'))).toBe(9000);
  });
});
