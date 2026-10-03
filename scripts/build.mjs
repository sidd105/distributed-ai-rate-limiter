import { cp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

await rm('dist', { recursive: true, force: true });
await execFileAsync(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '-p',
  'tsconfig.build.json',
]);
await mkdir('dist/src/limiter/scripts', { recursive: true });
await cp('src/limiter/scripts', 'dist/src/limiter/scripts', { recursive: true });
