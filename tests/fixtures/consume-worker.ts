import { RateLimiter } from '../../src/limiter/limiter.js';
import { RedisScripts } from '../../src/limiter/redis.js';
import { createTelemetry } from '../../src/telemetry.js';

async function main() {
  const [secret, tenantId, workerId] = process.argv.slice(2);
  if (!secret || !tenantId || !workerId || !process.env.TEST_REDIS_URL)
    throw new Error('Missing worker configuration');
  const telemetry = createTelemetry(workerId, 'silent');
  const redis = new RedisScripts(process.env.TEST_REDIS_URL, 5000, telemetry);
  try {
    await redis.connect();
    const limiter = new RateLimiter(redis, secret, telemetry);
    process.send?.({ type: 'ready' });
    await new Promise((resolve) => process.once('message', resolve));
    const results = await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        limiter.reserve({
          tenantId,
          userId: `${workerId}-${i}`,
          idempotencyKey: `worker-${workerId}-${i}`,
          fingerprint: 'process-race',
          buckets: [
            { key: 'req:shared', capacity: 100, refillRate: 0.001, cost: 1, unit: 'requests' },
          ],
        }),
      ),
    );
    process.send?.({
      type: 'done',
      allowed: results.filter((r) => r.status === 'allowed').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
    });
  } finally {
    await redis.close();
    process.disconnect?.();
  }
}
void main().catch((error) => {
  process.send?.({ type: 'error', message: String(error) });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
