import { readFile } from 'node:fs/promises';
import { createClient, type RedisClientType } from 'redis';
import type { Telemetry } from '../telemetry.js';
import { LimiterIntegrityError } from './types.js';

type ScriptName = 'reserve' | 'settle';
export class RedisDeadlineError extends Error {
  override name = 'RedisDeadlineError';
}

/** A timeout is an ambiguous outcome, not cancellation of a Redis write. */
export class RedisScripts {
  private readonly client: RedisClientType;
  private readonly shas = new Map<ScriptName, string>();
  private readonly sources = new Map<ScriptName, string>();
  private pendingCommands = 0;
  private integrityFault = false;

  constructor(
    redisUrl: string,
    private readonly timeoutMs: number,
    private readonly telemetry: Telemetry,
    private readonly maxPending = 512,
  ) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new Error('Invalid pending limit');
    this.client = createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: maxPending,
      socket: {
        connectTimeout: timeoutMs,
        reconnectStrategy: (retries) => Math.min(50 * 2 ** Math.min(retries, 5), 1000),
      },
    });
    this.client.on('error', (error: Error) =>
      telemetry.logger.error({ err: error }, 'redis client error'),
    );
  }

  async connect(): Promise<void> {
    const deadline = performance.now() + this.timeoutMs;
    try {
      if (!this.client.isOpen) await this.withDeadline(this.client.connect(), deadline);
      const common = await this.withDeadline(
        readFile(new URL('./scripts/common.lua', import.meta.url), 'utf8'),
        deadline,
      );
      for (const name of ['reserve', 'settle'] as const) {
        const source = await this.withDeadline(
          readFile(new URL(`./scripts/${name}.lua`, import.meta.url), 'utf8'),
          deadline,
        );
        this.sources.set(name, common + '\n' + source);
        await this.loadScript(name, deadline);
      }
    } catch (error) {
      if (this.client.isOpen) this.client.destroy();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    try {
      await this.withDeadline(this.client.quit(), performance.now() + this.timeoutMs);
    } finally {
      if (this.client.isOpen) this.client.destroy();
    }
  }

  async ping(): Promise<boolean> {
    if (this.integrityFault || this.shas.size !== 2) return false;
    try {
      return (
        (await this.command(() => this.client.ping(), performance.now() + this.timeoutMs)) ===
        'PONG'
      );
    } catch {
      return false;
    }
  }

  rawClient(): RedisClientType {
    return this.client;
  }

  async execute(name: ScriptName, keys: string[], args: string[]): Promise<unknown> {
    if (this.integrityFault)
      throw new LimiterIntegrityError('Redis integrity fault requires operator recovery');
    const started = performance.now();
    const deadline = started + this.timeoutMs;
    let outcome = 'ok';
    try {
      const sha = this.shas.get(name);
      if (!sha) throw new Error(`script ${name} is not loaded`);
      try {
        return await this.command(
          () => this.client.evalSha(sha, { keys, arguments: args }),
          deadline,
        );
      } catch (error) {
        // Only a definite NOSCRIPT means the original admission did not execute.
        if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
        await this.loadScript(name, deadline);
        return await this.command(
          () => this.client.evalSha(this.shas.get(name)!, { keys, arguments: args }),
          deadline,
        );
      }
    } catch (error) {
      outcome = 'error';
      this.telemetry.metrics.luaErrors.inc({ script: name });
      throw error;
    } finally {
      this.telemetry.metrics.redisDuration.observe(
        { script: name, outcome },
        (performance.now() - started) / 1000,
      );
    }
  }

  private async loadScript(name: ScriptName, deadline: number): Promise<void> {
    const source = this.sources.get(name);
    if (!source) throw new Error('script source is not loaded');
    this.shas.set(name, await this.command(() => this.client.scriptLoad(source), deadline));
  }

  private async command<T>(dispatch: () => Promise<T>, deadline: number): Promise<T> {
    if (performance.now() >= deadline) throw new RedisDeadlineError('Redis operation timed out');
    if (this.pendingCommands >= this.maxPending)
      throw new Error('Redis pending command limit reached');
    this.pendingCommands += 1;
    const pending = Promise.resolve()
      .then(dispatch)
      .catch((error: unknown) => {
        // Observe integrity faults even if the HTTP caller already timed out.
        if (error instanceof Error && /^(ERR|OOM|MISCONF)\b/.test(error.message)) {
          this.integrityFault = true;
          this.telemetry.logger.error('Redis integrity incident; instance latched unready');
        }
        throw error;
      })
      .finally(() => {
        // Do not release this slot when only the caller's timeout fires. Redis may
        // still be processing it; retaining the slot bounds blackholed connections.
        this.pendingCommands -= 1;
      });
    return this.withDeadline(pending, deadline);
  }

  private async withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new RedisDeadlineError('Redis operation timed out')),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
