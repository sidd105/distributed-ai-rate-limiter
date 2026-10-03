import type { AuthContext } from '../auth.js';
import { semanticFingerprint } from '../limiter/limiter.js';
import type { RateLimiter } from '../limiter/limiter.js';
import type { BucketInput, ReserveResult } from '../limiter/types.js';
import type { Telemetry } from '../telemetry.js';
import { simulateLlm, simulateRetrieval } from './adapters.js';

export interface SupportRequest {
  question: string;
  estimatedTokens: number;
  simulatedActualTokens: number;
  simulateUnknownUsage: boolean;
  model: 'support-small';
}

export interface SupportSuccess {
  answer: string;
  model: string;
  reservedTokens: number;
  actualTokens?: number;
  reconciliation: string;
}

function policy(context: AuthContext, request: SupportRequest): BucketInput[] {
  return [
    { key: 'req:tenant', capacity: 100, refillRate: 10, cost: 2, unit: 'requests' },
    { key: `req:user:${context.userId}`, capacity: 10, refillRate: 1, cost: 2, unit: 'requests' },
    { key: 'req:endpoint:support-answer', capacity: 40, refillRate: 4, cost: 2, unit: 'requests' },
    {
      key: 'tok:tenant',
      capacity: 120_000,
      refillRate: 2_000,
      cost: request.estimatedTokens,
      unit: 'tokens',
    },
    {
      key: `tok:user:${context.userId}`,
      capacity: 20_000,
      refillRate: 300,
      cost: request.estimatedTokens,
      unit: 'tokens',
    },
    {
      key: `tok:model:${request.model}`,
      capacity: 60_000,
      refillRate: 1_000,
      cost: request.estimatedTokens,
      unit: 'tokens',
    },
  ];
}

export async function handleSupportRequest(
  limiter: RateLimiter,
  telemetry: Telemetry,
  context: AuthContext,
  idempotencyKey: string,
  request: SupportRequest,
): Promise<{ admission: ReserveResult; result?: SupportSuccess }> {
  const fingerprint = semanticFingerprint({
    tenantId: context.tenantId,
    userId: context.userId,
    endpoint: 'support-answer',
    ...request,
  });
  const admission = await limiter.reserve(
    { ...context, idempotencyKey, fingerprint, buckets: policy(context, request) },
    'support-answer',
  );
  if (admission.status !== 'allowed') return { admission };

  telemetry.metrics.reservedTokens.inc({ model: request.model }, request.estimatedTokens);
  telemetry.metrics.inflight.inc();
  try {
    const retrieval = await simulateRetrieval(request.question);
    const estimatedPromptTokens =
      Math.ceil(request.question.length / 4) + retrieval.estimatedContextTokens;
    if (estimatedPromptTokens > request.estimatedTokens) {
      const settlement = await limiter.settle(admission.handle, 0, 'PRE_DISPATCH_ABORT');
      return {
        admission,
        result: {
          answer: 'Prompt exceeded the reserved token bound; inference was not attempted.',
          model: request.model,
          reservedTokens: request.estimatedTokens,
          actualTokens: 0,
          reconciliation: settlement.status,
        },
      };
    }

    const llm = await simulateLlm(
      request.question,
      request.simulatedActualTokens,
      !request.simulateUnknownUsage,
    );
    if (llm.actualTokens === undefined) {
      return {
        admission,
        result: {
          answer: llm.answer,
          model: request.model,
          reservedTokens: request.estimatedTokens,
          reconciliation: 'full_reservation_retained_unknown_usage',
        },
      };
    }
    const settlement = await limiter.settle(admission.handle, llm.actualTokens, 'COMPLETED');
    telemetry.metrics.reconciledTokens.inc(
      { model: request.model, outcome: settlement.status },
      llm.actualTokens,
    );
    return {
      admission,
      result: {
        answer: llm.answer,
        model: request.model,
        reservedTokens: request.estimatedTokens,
        actualTokens: llm.actualTokens,
        reconciliation: settlement.status,
      },
    };
  } finally {
    telemetry.metrics.inflight.dec();
  }
}
