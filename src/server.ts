import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { authenticate } from './auth.js';
import { RateLimiter, semanticFingerprint } from './limiter/limiter.js';
import { PolicyValidationError } from './limiter/policy.js';
import { RedisScripts } from './limiter/redis.js';
import type { BucketInput, ReserveResult } from './limiter/types.js';
import { createTelemetry, httpLabels } from './telemetry.js';
import { handleSupportRequest, type SupportRequest } from './support/handler.js';

const config = loadConfig();
const telemetry = createTelemetry(config.instanceId, config.logLevel);
const redis = new RedisScripts(config.redisUrl, config.redisTimeoutMs, telemetry);
const limiter = new RateLimiter(redis, config.keyHmacSecret, telemetry);
// Demo callers can deliberately submit incompatible policies. Keep their
// integrity latch/queue separate from the protected workflow as well as keys.
const demoRedis = new RedisScripts(config.redisUrl, config.redisTimeoutMs, telemetry);
const demoLimiter = new RateLimiter(demoRedis, config.keyHmacSecret, telemetry, 'demo');
const MAX_SUPPORT_INFLIGHT = 32;
let supportInflight = 0;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'body exceeds 64 KiB');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'body must be valid JSON');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'body must be an object');
  }
  return value as Record<string, unknown>;
}

function numberField(value: unknown, name: string, fallback?: number): number {
  const actual = value ?? fallback;
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new HttpError(400, 'INVALID_REQUEST', `${name} must be a number`);
  }
  return actual;
}

function parseBucket(value: unknown): BucketInput {
  const body = record(value);
  if (typeof body.key !== 'string') throw new HttpError(400, 'INVALID_REQUEST', 'key is required');
  const unit = body.unit ?? 'tokens';
  if (unit !== 'tokens' && unit !== 'requests') {
    throw new HttpError(400, 'INVALID_REQUEST', 'unit must be requests or tokens');
  }
  const parsed: BucketInput = {
    key: body.key,
    cost: numberField(body.cost, 'cost'),
    capacity: numberField(body.capacity, 'capacity'),
    refillRate: numberField(body.refillRate, 'refillRate'),
    unit,
  };
  for (const [name, numeric] of Object.entries({
    cost: parsed.cost,
    capacity: parsed.capacity,
    refillRate: parsed.refillRate,
  })) {
    if (numeric <= 0 || numeric > 1_000_000 || !Number.isSafeInteger(numeric * 1_000)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        `${name} must be positive, <= 1000000, with at most three decimal places`,
      );
    }
  }
  return parsed;
}

function idempotencyKey(request: IncomingMessage, required: boolean): string {
  const value = request.headers['idempotency-key'];
  if (typeof value === 'string' && /^[\x21-\x7e]{16,128}$/.test(value)) return value;
  if (required)
    throw new HttpError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 16-128 ASCII characters',
    );
  return randomUUID();
}

function admissionResponse(
  response: ServerResponse,
  result: Exclude<ReserveResult, { status: 'allowed' }>,
): void {
  if (result.status === 'rejected') {
    const retrySeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    json(
      response,
      429,
      { error: 'RATE_LIMITED', retryAfterMs: result.retryAfterMs },
      { 'retry-after': String(retrySeconds) },
    );
  } else if (result.status === 'impossible') {
    json(response, 422, { error: 'REQUEST_EXCEEDS_LIMIT', failingIndex: result.failingIndex });
  } else if (result.status === 'conflict') {
    json(response, 409, { error: 'IDEMPOTENCY_CONFLICT' });
  } else {
    json(response, 409, {
      error:
        result.operationStatus === 'SETTLED' ? 'OPERATION_ALREADY_PROCESSED' : 'OPERATION_PENDING',
    });
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health/live') {
    json(response, 200, { status: 'ok', instance: config.instanceId });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    const ready = await redis.ping();
    json(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/metrics') {
    response.writeHead(200, { 'content-type': telemetry.registry.contentType });
    response.end(await telemetry.registry.metrics());
    return;
  }
  if (request.method !== 'POST') throw new HttpError(404, 'NOT_FOUND', 'route not found');

  const context = authenticate(request.headers.authorization, config.demoAuthToken);
  if (!context) throw new HttpError(401, 'UNAUTHORIZED', 'valid demo bearer token required');

  if (url.pathname === '/v1/limits/consume') {
    const body = record(await readJson(request));
    const buckets = Array.isArray(body.buckets)
      ? body.buckets.map(parseBucket)
      : [parseBucket(body)];
    const operationId = idempotencyKey(request, false);
    const result = await demoLimiter.reserve(
      {
        ...context,
        idempotencyKey: operationId,
        fingerprint: semanticFingerprint({ endpoint: 'consume', buckets }),
        buckets,
      },
      'consume',
    );
    if (result.status !== 'allowed') return admissionResponse(response, result);
    json(response, 200, {
      allowed: true,
      remaining: result.remaining.length === 1 ? result.remaining[0] : result.remaining,
      consumed: result.consumed.length === 1 ? result.consumed[0] : result.consumed,
      capacity: result.capacity.length === 1 ? result.capacity[0] : result.capacity,
      retryAfter: 0,
    });
    return;
  }

  if (url.pathname === '/v1/support/answer') {
    if (supportInflight >= MAX_SUPPORT_INFLIGHT) {
      throw new HttpError(503, 'INSTANCE_SATURATED', 'local inference capacity is full');
    }
    const body = record(await readJson(request));
    if (
      typeof body.question !== 'string' ||
      body.question.length < 1 ||
      body.question.length > 4_000
    ) {
      throw new HttpError(400, 'INVALID_REQUEST', 'question must contain 1-4000 characters');
    }
    const estimatedTokens = numberField(body.estimatedTokens, 'estimatedTokens', 5_000);
    const simulatedActualTokens = numberField(
      body.simulatedActualTokens,
      'simulatedActualTokens',
      3_700,
    );
    if (
      !Number.isSafeInteger(estimatedTokens) ||
      estimatedTokens < 100 ||
      estimatedTokens > 8_000 ||
      !Number.isSafeInteger(simulatedActualTokens) ||
      simulatedActualTokens < 0 ||
      simulatedActualTokens > 10_000
    ) {
      throw new HttpError(400, 'INVALID_REQUEST', 'token counts are outside demo bounds');
    }
    if (body.model !== undefined && body.model !== 'support-small') {
      throw new HttpError(400, 'INVALID_REQUEST', 'model is not allowed');
    }
    const supportRequest: SupportRequest = {
      question: body.question,
      estimatedTokens,
      simulatedActualTokens,
      simulateUnknownUsage: body.simulateUnknownUsage === true,
      model: 'support-small',
    };
    supportInflight += 1;
    let result: Awaited<ReturnType<typeof handleSupportRequest>>;
    try {
      result = await handleSupportRequest(
        limiter,
        telemetry,
        context,
        idempotencyKey(request, true),
        supportRequest,
      );
    } finally {
      supportInflight -= 1;
    }
    if (result.admission.status !== 'allowed') return admissionResponse(response, result.admission);
    json(response, 200, result.result);
    return;
  }

  throw new HttpError(404, 'NOT_FOUND', 'route not found');
}

await redis.connect();
await demoRedis.connect();
const server = createServer((request, response) => {
  const requestId = randomUUID();
  const started = performance.now();
  void route(request, response)
    .catch((error: unknown) => {
      if (error instanceof HttpError)
        return json(response, error.status, { error: error.code, message: error.message });
      if (error instanceof PolicyValidationError) {
        return json(response, 400, { error: 'INVALID_LIMIT_POLICY', message: error.message });
      }
      telemetry.logger.error({ err: error, requestId }, 'request failed');
      json(response, 503, { error: 'LIMITER_UNAVAILABLE' });
    })
    .finally(() => {
      const labels = httpLabels(request.url, request.method, response.statusCode);
      telemetry.metrics.httpRequests.inc(labels);
      telemetry.logger.info(
        {
          requestId,
          method: request.method,
          path: labels.route,
          status: response.statusCode,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        },
        'request completed',
      );
    });
});

server.listen(config.port, () => telemetry.logger.info({ port: config.port }, 'server listening'));

async function shutdown(signal: string): Promise<void> {
  telemetry.logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.all([redis.close(), demoRedis.close()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
