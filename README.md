# distributed-ai-rate-limiter

If two API instances each enforce a limit of 100 requests locally, together they can allow 200. This project uses Redis to keep them on one shared budget.

It also handles token budgets for AI requests: reserve tokens before inference, then reconcile the actual usage. The example is a payment-support assistant with simulated retrieval and LLM calls—no paid API needed.

Built with **TypeScript, Node.js, Redis, and Lua**, with Vitest tests and k6 load scenarios.

## Run locally

With Docker Desktop and Compose installed:

```bash
docker compose up --build
```

This starts two app instances on `localhost:3001` and `localhost:3002`, sharing one Redis instance. Both expose `/health/ready` and Prometheus metrics at `/metrics`.

## Try it

```bash
curl http://localhost:3001/v1/support/answer \
  -H 'authorization: Bearer demo-payment-support-token' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: support-example-0001' \
  --data '{
    "question": "Why did payment pay_123 fail?",
    "estimatedTokens": 5000,
    "simulatedActualTokens": 3700
  }'
```

This reserves 5,000 tokens, simulates using 3,700, and returns the unused 1,300 to each applicable token bucket, up to its capacity. Request charges remain consumed. Repeating the same key returns `409` while its operation record exists; use a new key for a new request.

For custom buckets, `POST /v1/limits/consume` accepts `key`, `cost`, `capacity`, `refillRate`, and `unit`, or a `buckets` array. Its demo buckets are separate from the support workflow.

## How it works

Each instance calls the same Lua scripts to refill, check, and debit Redis buckets without another request interleaving. A normal quota rejection changes none of the buckets. Limits cover users, merchants, endpoints, and models, with weighted costs and burst capacity.

Redis supplies the clock. Known excess token usage becomes debt; unknown usage keeps the full reservation. Exhausted quotas return `429`, and Redis failures during admission return `503` without starting inference.

## Tests

With Node.js 22 and Docker available:

```bash
npm ci
npm run check
npm run test:integration
npm run build
```

Integration tests use disposable Redis. The four-process concurrency test sends 1,000 requests to a capacity-100 bucket: **100 allowed, 900 rejected**, before enough refill for another request. Tests also cover duplicate requests, refunds, debt, clock changes, and Redis failures.

The [load scripts](load) cover bursts, sustained traffic, hot keys, many keys, and weighted token costs. Set a fresh `RUN_ID` for each k6 run. These are local experiments, not production capacity guarantees.

## Limits

This is a demo: authentication maps to one fixed tenant/user, and token estimates are not enforced provider bounds. Failed settlements are not retried, responses are not cached, and Redis data loss can remove quota and retry protection. Lua prevents interleaving but cannot roll back an unexpected write error.

Keep the example credentials local. Real deployment needs proper authentication, provider token caps, settlement recovery, and tested Redis availability.
