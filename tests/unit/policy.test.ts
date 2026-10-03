import { describe, expect, it } from 'vitest';
import { KeyFactory } from '../../src/limiter/keys.js';
import { resolveBuckets } from '../../src/limiter/policy.js';

const keys = new KeyFactory('a-secret-long-enough-for-tests');

describe('policy resolution and keys', () => {
  it('scales units and keeps every tenant bucket in one hash slot', () => {
    const buckets = resolveBuckets(
      'merchant@example.com',
      [
        { key: 'req:user:alice', capacity: 10, refillRate: 0.5, cost: 2, unit: 'requests' },
        { key: 'tok:tenant', capacity: 50_000, refillRate: 1_000, cost: 1_200, unit: 'tokens' },
      ],
      keys,
    );
    expect(buckets[0]?.redisKey.match(/\{([^}]+)\}/)?.[1]).toBe(
      buckets[1]?.redisKey.match(/\{([^}]+)\}/)?.[1],
    );
    expect(buckets.some((bucket) => bucket.redisKey.includes('merchant@example.com'))).toBe(false);
    expect(buckets.find((bucket) => bucket.key === 'req:user:alice')?.refillRateCredits).toBe(500);
  });

  it('rejects duplicates and excessive precision', () => {
    const bucket = { key: 'same', capacity: 10, refillRate: 1, cost: 1, unit: 'requests' as const };
    expect(() => resolveBuckets('tenant', [bucket, bucket], keys)).toThrow('duplicate');
    expect(() => resolveBuckets('tenant', [{ ...bucket, refillRate: 0.0001 }], keys)).toThrow(
      'three decimal places',
    );
  });
});
