import { createHash } from 'node:crypto';
import {
  MAX_DIMENSIONS,
  MAX_VALUE,
  SCALE,
  type BucketInput,
  type ResolvedBucket,
} from './types.js';
import type { KeyFactory } from './keys.js';

export class PolicyValidationError extends Error {
  override name = 'PolicyValidationError';
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_VALUE) {
    throw new PolicyValidationError(`${name} must be finite, positive, and <= ${MAX_VALUE}`);
  }
  if (!Number.isSafeInteger(value * SCALE)) {
    throw new PolicyValidationError(`${name} supports at most three decimal places`);
  }
}

export function resolveBuckets(
  tenantId: string,
  buckets: BucketInput[],
  keys: KeyFactory,
): ResolvedBucket[] {
  if (buckets.length === 0 || buckets.length > MAX_DIMENSIONS) {
    throw new PolicyValidationError(`buckets must contain 1-${MAX_DIMENSIONS} entries`);
  }
  const logicalKeys = new Set<string>();
  const resolved = buckets.map((bucket) => {
    if (!/^[a-zA-Z0-9:_./-]{1,128}$/.test(bucket.key)) {
      throw new PolicyValidationError('invalid bucket key');
    }
    if (logicalKeys.has(bucket.key)) {
      throw new PolicyValidationError(`duplicate bucket key: ${bucket.key}`);
    }
    logicalKeys.add(bucket.key);
    positive('capacity', bucket.capacity);
    positive('refillRate', bucket.refillRate);
    positive('cost', bucket.cost);
    if (bucket.unit !== 'requests' && bucket.unit !== 'tokens') {
      throw new PolicyValidationError('invalid unit');
    }

    const policyHash = createHash('sha256')
      .update(`${bucket.key}|${bucket.unit}|${bucket.capacity}|${bucket.refillRate}`)
      .digest('hex');
    return {
      ...bucket,
      redisKey: keys.bucket(tenantId, bucket.key),
      policyHash,
      capacityCredits: bucket.capacity * SCALE,
      refillRateCredits: bucket.refillRate * SCALE,
      costCredits: bucket.cost * SCALE,
    };
  });
  return resolved.sort((a, b) => a.redisKey.localeCompare(b.redisKey));
}
