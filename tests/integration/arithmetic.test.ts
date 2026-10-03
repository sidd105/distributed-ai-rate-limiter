import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { redisFixture } from '../fixtures/redis.js';

it('matches an exact BigInt refill/TTL oracle across 500 fractional, debt and clock cases', async () => {
  const f = await redisFixture(1);
  try {
    const common = await readFile(
      new URL('../../src/limiter/scripts/common.lua', import.meta.url),
      'utf8',
    );
    const script =
      common +
      `
      local s = { balance=tonumber(ARGV[1]), remainder=tonumber(ARGV[2]),
        last_ms=tonumber(ARGV[3]), capacity=tonumber(ARGV[4]), rate=tonumber(ARGV[5]), is_token=1 }
      local now = tonumber(ARGV[6])
      refill(s, now)
      prepare_bucket(s, now)
      return {s.balance, s.remainder, s.last_ms, s.ttl}
    `;
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const cases: bigint[][] = [
      [0n, 999n, 1000n, 10000n, 1n, 1001n],
      [-1000000000000n, 0n, 60000n, 1000000000n, 1n, 1000n],
      [-1000000000000n, 123n, 0n, 1000000000n, 1000000000n, 1000000000000n],
    ];
    while (cases.length < 500) {
      const capacity = BigInt((random() % 1_000_000_000) + 1);
      const b = -(BigInt(random()) * 200n) + capacity;
      cases.push([
        b,
        BigInt(random() % 1000),
        60000n,
        capacity,
        BigInt((random() % 1_000_000_000) + 1),
        BigInt(random()),
      ]);
    }
    for (const values of cases) {
      const [b, rem, last, cap, rate, now] = values as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const effective = now > last ? now : last;
      const numerator = (effective - last) * rate + rem;
      let balance = b + numerator / 1000n;
      let remainder = numerator % 1000n;
      if (balance >= cap) {
        balance = cap;
        remainder = 0n;
      }
      const need = (cap - balance) * 1000n - remainder;
      const ttl = effective - now + (need + rate - 1n) / rate + 1000n;
      const reply = await f.clients[0]!.rawClient().eval(script, { arguments: values.map(String) });
      expect(reply).toEqual([balance, remainder, effective, ttl].map(Number));
    }
  } finally {
    await f.close();
  }
});
