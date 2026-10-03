import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyFactory } from '../../src/limiter/keys.js';
import { semanticFingerprint } from '../../src/limiter/limiter.js';
import { redisFixture } from '../fixtures/redis.js';

let fixture: Awaited<ReturnType<typeof redisFixture>>;
let clients: Awaited<ReturnType<typeof redisFixture>>['clients'];
let limiters: Awaited<ReturnType<typeof redisFixture>>['limiters'];
let secret: string;
beforeEach(async () => {
  fixture = await redisFixture();
  ({ clients, limiters, secret } = fixture);
});
afterEach(async () => fixture.close());

describe('distributed limiter with real Redis', () => {
  it('allows exactly 100 concurrent unit requests across clients', async () => {
    const attempts = Array.from({ length: 1_000 }, (_, index) =>
      limiters[index % limiters.length]!.reserve({
        tenantId: 'concurrency-tenant',
        userId: `user-${index}`,
        idempotencyKey: `operation-${String(index).padStart(16, '0')}`,
        fingerprint: semanticFingerprint({ index }),
        buckets: [
          { key: 'req:tenant', capacity: 100, refillRate: 0.001, cost: 1, unit: 'requests' },
        ],
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((result) => result.status === 'allowed')).toHaveLength(100);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(900);
  });

  it('does not debit any dimension when one dimension rejects', async () => {
    const base = {
      tenantId: 'atomic-tenant',
      userId: 'user',
      buckets: [
        { key: 'req:empty', capacity: 1, refillRate: 0.001, cost: 1, unit: 'requests' as const },
        { key: 'req:other', capacity: 10, refillRate: 0.001, cost: 1, unit: 'requests' as const },
      ],
    };
    const first = await limiters[0]!.reserve({
      ...base,
      idempotencyKey: 'atomic-operation-0001',
      fingerprint: semanticFingerprint('first'),
    });
    expect(first.status).toBe('allowed');
    const second = await limiters[1]!.reserve({
      ...base,
      idempotencyKey: 'atomic-operation-0002',
      fingerprint: semanticFingerprint('second'),
    });
    expect(second.status).toBe('rejected');
    const keys = new KeyFactory(secret);
    const otherBalance = await clients[0]!
      .rawClient()
      .hGet(keys.bucket('atomic-tenant', 'req:other'), 'balance');
    expect(Number(otherBalance)).toBe(9_000);
  });

  it('deduplicates reservations and reconciles unused tokens once', async () => {
    const input = {
      tenantId: 'ai-tenant',
      userId: 'user',
      idempotencyKey: 'ai-operation-0000001',
      fingerprint: semanticFingerprint({ prompt: 'refund status' }),
      buckets: [
        { key: 'req:user', capacity: 10, refillRate: 0.001, cost: 1, unit: 'requests' as const },
        {
          key: 'tok:user',
          capacity: 20_000,
          refillRate: 0.001,
          cost: 5_000,
          unit: 'tokens' as const,
        },
      ],
    };
    const [first, ...duplicates] = await Promise.all([
      limiters[0]!.reserve(input),
      ...limiters.slice(1).map((limiter) => limiter.reserve(input)),
    ]);
    const allowed = [first, ...duplicates].find((result) => result.status === 'allowed');
    expect([first, ...duplicates].filter((result) => result.status === 'allowed')).toHaveLength(1);
    expect(allowed?.status).toBe('allowed');
    if (allowed?.status !== 'allowed') throw new Error('expected one allowed result');

    const settled = await limiters[0]!.settle(allowed.handle, 3_700, 'COMPLETED');
    expect(settled).toMatchObject({ status: 'settled', refundedTokens: 1_300 });
    expect(await limiters[1]!.settle(allowed.handle, 3_700, 'COMPLETED')).toEqual({
      status: 'already_settled',
    });
  });
});
