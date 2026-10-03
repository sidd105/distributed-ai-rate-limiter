import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let container;
let redisUrl = process.env.TEST_REDIS_URL;
try {
  if (!redisUrl) {
    const result = await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '-p',
      '127.0.0.1::6379',
      'redis:7.4-alpine',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory-policy',
      'noeviction',
    ]);
    container = result.stdout.trim();
    const { stdout } = await exec('docker', ['port', container, '6379/tcp']);
    const port = stdout.trim().split(':').at(-1);
    redisUrl = `redis://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const ready = await exec('docker', ['exec', container, 'redis-cli', 'ping']);
        if (ready.stdout.trim() === 'PONG') break;
      } catch {
        /* Container is still starting. */
      }
      if (attempt === 29) throw new Error('Disposable Redis did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--dir',
      'tests/integration',
      '--pool=forks',
      '--maxWorkers=1',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, TEST_REDIS_URL: redisUrl } },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  if (container) await exec('docker', ['stop', container]);
}
