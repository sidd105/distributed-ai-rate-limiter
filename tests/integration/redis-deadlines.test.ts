import { afterEach, expect, it, vi } from 'vitest';
import { redisFixture } from '../fixtures/redis.js';

afterEach(() => vi.restoreAllMocks());

it('latches unready on an integrity error arriving after the caller timed out', async () => {
  const f = await redisFixture(1, 200);
  let fail!: (error: Error) => void;
  try {
    vi.spyOn(f.clients[0]!.rawClient(), 'evalSha').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    await expect(f.clients[0]!.execute('reserve', [], [])).rejects.toThrow('timed out');
    fail(new Error('ERR injected late write-phase failure'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await f.clients[0]!.ping()).toBe(false);
    await expect(f.clients[0]!.execute('reserve', [], [])).rejects.toThrow('operator recovery');
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('bounds the NOSCRIPT reload by the original deadline and does not replay after timeout', async () => {
  const f = await redisFixture(1, 200);
  let finish!: (value: string) => void;
  try {
    const raw = f.clients[0]!.rawClient();
    const evalSpy = vi.spyOn(raw, 'evalSha').mockRejectedValueOnce(new Error('NOSCRIPT missing'));
    vi.spyOn(raw, 'scriptLoad').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(f.clients[0]!.execute('reserve', [], [])).rejects.toThrow('timed out');
    expect(evalSpy).toHaveBeenCalledTimes(1);
    finish('late-sha');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(evalSpy).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('retains pending slots after caller timeout until the underlying Redis reply arrives', async () => {
  const f = await redisFixture(1, 200, 2);
  const finish: Array<() => void> = [];
  try {
    const raw = f.clients[0]!.rawClient();
    const evalSpy = vi.spyOn(raw, 'evalSha').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(() => resolve([3, 1]));
        }),
    );
    const settled = await Promise.allSettled([
      f.clients[0]!.execute('reserve', [], []),
      f.clients[0]!.execute('reserve', [], []),
    ]);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    await expect(f.clients[0]!.execute('reserve', [], [])).rejects.toThrow('pending command limit');
    expect(evalSpy).toHaveBeenCalledTimes(2);
    finish.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 5));
    evalSpy.mockResolvedValue([3, 1]);
    expect(await f.clients[0]!.execute('reserve', [], [])).toEqual([3, 1]);
  } finally {
    finish.forEach((resolve) => resolve());
    vi.restoreAllMocks();
    await f.close();
  }
});
