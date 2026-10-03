import pino from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const knownRoutes = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
  '/v1/limits/consume',
  '/v1/support/answer',
]);
const knownMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function httpLabels(url: string | undefined, method: string | undefined, status: number) {
  const path = (url ?? '/').split('?', 1)[0] ?? '/';
  return {
    route: knownRoutes.has(path) ? path : 'unmatched',
    method: method && knownMethods.has(method) ? method : 'OTHER',
    status_class: `${Math.floor(status / 100)}xx`,
  };
}

export function createTelemetry(instanceId: string, level: string) {
  const logger = pino({ level, base: { service: 'distributed-ai-rate-limiter', instanceId } });
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'distributed-ai-rate-limiter', instance: instanceId });
  collectDefaultMetrics({ register: registry });

  const decisions = new Counter({
    name: 'limiter_decisions_total',
    help: 'Rate-limit decisions',
    labelNames: ['decision', 'reason', 'endpoint'] as const,
    registers: [registry],
  });
  const httpRequests = new Counter({
    name: 'limiter_http_requests_total',
    help: 'HTTP requests handled by the application',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [registry],
  });
  const redisDuration = new Histogram({
    name: 'limiter_redis_duration_seconds',
    help: 'Redis Lua operation latency',
    labelNames: ['script', 'outcome'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [registry],
  });
  const luaErrors = new Counter({
    name: 'limiter_lua_errors_total',
    help: 'Lua execution errors',
    labelNames: ['script'] as const,
    registers: [registry],
  });
  const reservedTokens = new Counter({
    name: 'limiter_reserved_tokens_total',
    help: 'LLM tokens reserved',
    labelNames: ['model'] as const,
    registers: [registry],
  });
  const reconciledTokens = new Counter({
    name: 'limiter_reconciled_tokens_total',
    help: 'Actual LLM tokens reconciled',
    labelNames: ['model', 'outcome'] as const,
    registers: [registry],
  });
  const inflight = new Gauge({
    name: 'limiter_inflight',
    help: 'Active business handlers on this instance',
    registers: [registry],
  });

  return {
    logger,
    registry,
    metrics: {
      httpRequests,
      decisions,
      redisDuration,
      luaErrors,
      reservedTokens,
      reconciledTokens,
      inflight,
    },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
