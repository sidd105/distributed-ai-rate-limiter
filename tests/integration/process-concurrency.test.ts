import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { KeyFactory } from '../../src/limiter/keys.js';
import { redisFixture } from '../fixtures/redis.js';

it('admits exactly 100 of 1000 synchronized requests from four separate Node processes', async () => {
  const f = await redisFixture(1);
  const tenant = `process-${randomUUID()}`;
  const children: ChildProcess[] = [];
  const raw = f.clients[0]!.rawClient();
  const keys = new KeyFactory(f.secret);
  const owned = [keys.bucket(tenant, 'req:shared')];
  const redisTime = async () => {
    const result = await raw.sendCommand(['TIME']);
    if (!Array.isArray(result)) throw new Error('Unexpected Redis TIME response');
    return Number(result[0]) * 1000 + Math.floor(Number(result[1]) / 1000);
  };
  try {
    const completions: Array<Promise<{ allowed: number; rejected: number }>> = [];
    const ready = Array.from(
      { length: 4 },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = fork(
            new URL('../fixtures/consume-worker.ts', import.meta.url),
            [f.secret, tenant, String(i)],
            { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
          );
          children.push(child);
          for (let n = 0; n < 250; n += 1)
            owned.push(keys.operation(tenant, `${i}-${n}`, `worker-${i}-${n}`));
          let complete!: (value: { allowed: number; rejected: number }) => void;
          let failed!: (error: Error) => void;
          completions.push(
            new Promise((ok, no) => {
              complete = ok;
              failed = no;
            }),
          );
          const fail = (error: Error) => {
            reject(error);
            failed(error);
          };
          child.once('error', fail);
          child.once('exit', (code) => {
            if (code !== 0) fail(new Error(`Worker exited ${code}`));
          });
          child.on(
            'message',
            (message: { type: string; allowed: number; rejected: number; message?: string }) => {
              if (message.type === 'ready') resolve();
              if (message.type === 'done') complete(message);
              if (message.type === 'error') fail(new Error(message.message));
            },
          );
        }),
    );
    await Promise.all(ready);
    const before = await redisTime();
    children.forEach((child) => child.send('start'));
    const results = await Promise.all(completions);
    const after = await redisTime();
    expect(after - before).toBeLessThan(1_000_000); // One complete unit takes 1000 seconds.
    expect(results.reduce((sum, r) => sum + r.allowed, 0)).toBe(100);
    expect(results.reduce((sum, r) => sum + r.rejected, 0)).toBe(900);
    expect(Number(await raw.hGet(owned[0]!, 'balance'))).toBeLessThan(1000);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await raw.del(owned);
    await f.close();
  }
});
