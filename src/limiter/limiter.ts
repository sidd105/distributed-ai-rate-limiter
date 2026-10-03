import { createHash, randomBytes } from 'node:crypto';
import type { Telemetry } from '../telemetry.js';
import { KeyFactory } from './keys.js';
import { resolveBuckets } from './policy.js';
import type { RedisScripts } from './redis.js';
import {
  LimiterIntegrityError,
  SCALE,
  type ReservationInput,
  type ReserveResult,
  type ReservationHandle,
  type SettlementResult,
} from './types.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const SETTLEMENT_HORIZON_MS = 10 * 60 * 1000;

function asArray(reply: unknown): Array<string | number> {
  if (!Array.isArray(reply)) throw new LimiterIntegrityError('unexpected Lua response');
  return reply as Array<string | number>;
}

function numberAt(reply: Array<string | number>, index: number): number {
  const value = Number(reply[index]);
  if (!Number.isSafeInteger(value)) throw new LimiterIntegrityError('invalid numeric Lua response');
  return value;
}

export function semanticFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class RateLimiter {
  private readonly keys: KeyFactory;

  constructor(
    private readonly redis: RedisScripts,
    secret: string,
    private readonly telemetry: Telemetry,
    namespace: 'protected' | 'demo' = 'protected',
  ) {
    this.keys = new KeyFactory(secret, namespace);
  }

  async reserve(input: ReservationInput, endpoint = 'unknown'): Promise<ReserveResult> {
    const buckets = resolveBuckets(input.tenantId, input.buckets, this.keys);
    const operationKey = this.keys.operation(input.tenantId, input.userId, input.idempotencyKey);
    const owner = randomBytes(16).toString('hex');
    const args = [
      input.fingerprint,
      owner,
      String(RETENTION_MS),
      String(SETTLEMENT_HORIZON_MS),
      String(buckets.length),
      ...buckets.flatMap((bucket) => [
        String(bucket.capacityCredits),
        String(bucket.refillRateCredits),
        String(bucket.costCredits),
        bucket.policyHash,
        bucket.unit,
        bucket.unit === 'tokens' ? '1' : '0',
      ]),
    ];
    const values = asArray(
      await this.redis.execute(
        'reserve',
        [operationKey, ...buckets.map((bucket) => bucket.redisKey)],
        args,
      ),
    );
    const code = numberAt(values, 0);
    if (code === 1) {
      this.telemetry.metrics.decisions.inc({ decision: 'rejected', reason: 'exhausted', endpoint });
      return {
        status: 'rejected',
        retryAfterMs: numberAt(values, 1),
        failingIndex: numberAt(values, 2) - 1,
      };
    }
    if (code === 2) return { status: 'impossible', failingIndex: numberAt(values, 1) - 1 };
    if (code === 3) {
      return {
        status: 'duplicate',
        operationStatus: numberAt(values, 1) === 2 ? 'SETTLED' : 'RESERVED',
      };
    }
    if (code === 4) return { status: 'conflict' };
    if (code !== 0) throw new LimiterIntegrityError(`unknown reserve result: ${code}`);

    const createdAtMs = numberAt(values, 1);
    const count = numberAt(values, 2);
    if (count !== buckets.length) throw new LimiterIntegrityError('bucket count mismatch');
    const remaining = buckets.map((_, index) => numberAt(values, 3 + index) / SCALE);
    this.telemetry.metrics.decisions.inc({ decision: 'allowed', reason: 'ok', endpoint });
    return {
      status: 'allowed',
      remaining,
      consumed: buckets.map((bucket) => bucket.cost),
      capacity: buckets.map((bucket) => bucket.capacity),
      handle: { operationKey, owner, fingerprint: input.fingerprint, buckets, createdAtMs },
    };
  }

  async settle(
    handle: ReservationHandle,
    actualTokens: number,
    outcome: string,
  ): Promise<SettlementResult> {
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > 1_000_000_000) {
      throw new Error('actualTokens must be a non-negative integer <= 1000000000');
    }
    if (!/^[A-Z_]{1,32}$/.test(outcome)) throw new Error('invalid settlement outcome');
    const args = [
      handle.fingerprint,
      handle.owner,
      String(actualTokens * SCALE),
      outcome,
      String(handle.buckets.length),
      ...handle.buckets.flatMap((bucket) => [
        String(bucket.capacityCredits),
        String(bucket.refillRateCredits),
        String(bucket.costCredits),
        bucket.policyHash,
        bucket.unit,
        bucket.unit === 'tokens' ? '1' : '0',
      ]),
    ];
    const values = asArray(
      await this.redis.execute(
        'settle',
        [handle.operationKey, ...handle.buckets.map((bucket) => bucket.redisKey)],
        args,
      ),
    );
    const code = numberAt(values, 0);
    if (code === 0) {
      return {
        status: 'settled',
        refundedTokens: numberAt(values, 1) / SCALE,
        excessTokens: numberAt(values, 2) / SCALE,
      };
    }
    if (code === 1) return { status: 'already_settled' };
    if (code === 2) return { status: 'conflict' };
    if (code === 3) return { status: 'unknown' };
    if (code === 4) return { status: 'expired' };
    throw new LimiterIntegrityError(`unknown settlement result: ${code}`);
  }
}
