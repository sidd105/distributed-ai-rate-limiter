import { randomUUID } from 'node:crypto';
import { RateLimiter } from '../../src/limiter/limiter.js';
import { RedisScripts } from '../../src/limiter/redis.js';
import { createTelemetry } from '../../src/telemetry.js';

export async function redisFixture(count = 4, timeoutMs = 1000, maxPending = 512) {
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error('Use npm run test:integration for disposable Redis');
  const secret = `test-${randomUUID()}`;
  const ownedKeys = new Set<string>();
  class TestRedis extends RedisScripts {
    override async execute(...args: Parameters<RedisScripts['execute']>): Promise<unknown> {
      for (const key of args[1]) ownedKeys.add(key);
      return super.execute(...args);
    }
  }
  const clients: RedisScripts[] = [];
  const limiters: RateLimiter[] = [];
  const telemetry = createTelemetry('test', 'silent');
  try {
    for (let i = 0; i < count; i += 1) {
      const client = new TestRedis(redisUrl, timeoutMs, telemetry, maxPending);
      clients.push(client);
      await client.connect();
      limiters.push(new RateLimiter(client, secret, telemetry));
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
  return {
    clients,
    limiters,
    secret,
    telemetry,
    async close() {
      try {
        // Only literal keys submitted by this fixture, never FLUSHDB or a broad SCAN/DEL.
        if (ownedKeys.size) await clients[0]!.rawClient().del([...ownedKeys]);
      } finally {
        await Promise.allSettled(clients.map((client) => client.close()));
      }
    },
  };
}
