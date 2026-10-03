import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { KeyFactory } from '../../src/limiter/keys.js';
import { redisFixture } from '../fixtures/redis.js';

it('keeps experimental policies, faults and anonymous metric labels out of the protected workflow', async () => {
  const f = await redisFixture(1);
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = fork(new URL('../../src/server.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PORT: String(address.port),
      REDIS_URL: process.env.TEST_REDIS_URL,
      KEY_HMAC_SECRET: f.secret,
      REDIS_TIMEOUT_MS: '2000',
      LOG_LEVEL: 'silent',
      DEMO_AUTH_TOKEN: 'http-review-token',
    },
  });
  const operation = randomUUID();
  const poisoned = randomUUID();
  const secondOperation = randomUUID();
  const post = (path: string, body: unknown, id: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer http-review-token',
        'idempotency-key': id,
      },
      body: JSON.stringify(body),
    });
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(base + '/health/ready')).status;
          } catch {
            return 0;
          }
        },
        { timeout: 5000, interval: 50 },
      )
      .toBe(200);
    const bucket = { key: 'req:tenant', capacity: 1, refillRate: 0.001, cost: 1, unit: 'requests' };
    expect((await post('/v1/limits/consume', bucket, operation)).status).toBe(200);
    const support = {
      question: 'Why was this payment declined?',
      estimatedTokens: 5000,
      simulatedActualTokens: 3700,
    };
    expect((await post('/v1/support/answer', support, operation)).status).toBe(200);
    // Incompatible demo policy latches only the experimental client.
    expect((await post('/v1/limits/consume', { ...bucket, capacity: 2 }, poisoned)).status).toBe(
      503,
    );
    expect((await fetch(base + '/health/ready')).status).toBe(200);
    expect((await post('/v1/support/answer', support, secondOperation)).status).toBe(200);
    expect((await post('/v1/support/answer', support, secondOperation)).status).toBe(409);
    await Promise.all(Array.from({ length: 100 }, (_, i) => fetch(`${base}/random-${i}`)));
    const metrics = await (await fetch(base + '/metrics')).text();
    const unmatched = metrics
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('limiter_http_requests_total') && line.includes('route="unmatched"'),
      );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatch(/ 100$/);
    expect(metrics).not.toContain('random-');
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    // Delete only this test's exact identity/policy keys, including keys created in the child.
    const protectedKeys = new KeyFactory(f.secret);
    const demoKeys = new KeyFactory(f.secret, 'demo');
    const buckets = [
      'req:tenant',
      'req:user:support-agent-demo',
      'req:endpoint:support-answer',
      'tok:tenant',
      'tok:user:support-agent-demo',
      'tok:model:support-small',
    ];
    await f.clients[0]!.rawClient().del([
      ...buckets.map((key) => protectedKeys.bucket('merchant-demo', key)),
      demoKeys.bucket('merchant-demo', 'req:tenant'),
      ...[operation, secondOperation].map((id) =>
        protectedKeys.operation('merchant-demo', 'support-agent-demo', id),
      ),
      ...[operation, poisoned].map((id) =>
        demoKeys.operation('merchant-demo', 'support-agent-demo', id),
      ),
    ]);
    await f.close();
  }
});
