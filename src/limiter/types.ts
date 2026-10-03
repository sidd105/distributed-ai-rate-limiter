export const SCALE = 1_000;
export const MAX_DIMENSIONS = 8;
// Public bucket values are units; Lua stores milli-units. This keeps configured
// capacity/rate at or below the architecture's 1e9-credit exactness bound.
export const MAX_VALUE = 1_000_000;

export type BucketUnit = 'requests' | 'tokens';

export interface BucketInput {
  key: string;
  capacity: number;
  refillRate: number;
  cost: number;
  unit: BucketUnit;
}

export interface ResolvedBucket extends BucketInput {
  redisKey: string;
  policyHash: string;
  capacityCredits: number;
  refillRateCredits: number;
  costCredits: number;
}

export interface ReservationInput {
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  fingerprint: string;
  buckets: BucketInput[];
}

export interface ReservationHandle {
  operationKey: string;
  owner: string;
  fingerprint: string;
  buckets: ResolvedBucket[];
  createdAtMs: number;
}

export type ReserveResult =
  | {
      status: 'allowed';
      consumed: number[];
      remaining: number[];
      capacity: number[];
      handle: ReservationHandle;
    }
  | { status: 'rejected'; retryAfterMs: number; failingIndex: number }
  | { status: 'impossible'; failingIndex: number }
  | { status: 'duplicate'; operationStatus: 'RESERVED' | 'SETTLED' }
  | { status: 'conflict' };

export type SettlementResult =
  | { status: 'settled'; refundedTokens: number; excessTokens: number }
  | { status: 'already_settled' }
  | { status: 'conflict' | 'unknown' | 'expired' };

export class LimiterIntegrityError extends Error {
  override name = 'LimiterIntegrityError';
}
