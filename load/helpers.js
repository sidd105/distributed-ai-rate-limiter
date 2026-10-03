import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

export const allowed = new Counter('limiter_allowed');
export const rejected = new Counter('limiter_rejected');
export const unexpected = new Counter('limiter_unexpected');

const baseUrls = (
  __ENV.BASE_URLS || 'http://host.docker.internal:3001,http://host.docker.internal:3002'
).split(',');
const auth = __ENV.AUTH_TOKEN || 'demo-payment-support-token';
// Set RUN_ID once per invocation. Module initialization happens per VU, so a
// timestamp here would accidentally create several buckets in one scenario.
const runId = __ENV.RUN_ID || 'local-run';

export function consume(bucket, cost, capacity, refillRate, unit = 'requests') {
  const index = (exec.vu.idInTest + exec.scenario.iterationInTest) % baseUrls.length;
  const idempotencyKey = `k6-${runId}-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const response = http.post(
    `${baseUrls[index]}/v1/limits/consume`,
    JSON.stringify({ key: `${bucket}:${runId}`, cost, capacity, refillRate, unit }),
    {
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      tags: { endpoint: 'consume' },
    },
  );
  if (response.status === 200) allowed.add(1);
  else if (response.status === 429) rejected.add(1);
  else unexpected.add(1);
  return response;
}

export const commonThresholds = {
  limiter_unexpected: ['count==0'],
  http_req_duration: ['p(95)<250', 'p(99)<500'],
  dropped_iterations: ['count==0'],
};
