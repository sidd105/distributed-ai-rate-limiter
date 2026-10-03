import { expect, it } from 'vitest';
import { createTelemetry, httpLabels } from '../../src/telemetry.js';

it('bounds unauthenticated route/method cardinality for arbitrary paths', async () => {
  const telemetry = createTelemetry('cardinality', 'silent');
  for (let i = 0; i < 10_000; i += 1) {
    telemetry.metrics.httpRequests.inc(httpLabels(`/unknown-${i}?secret=${i}`, `CUSTOM_${i}`, 404));
  }
  const metric = await telemetry.metrics.httpRequests.get();
  expect(metric.values).toHaveLength(1);
  expect(metric.values[0]).toMatchObject({
    value: 10_000,
    labels: { route: 'unmatched', method: 'OTHER' },
  });
  expect(httpLabels('/v1/support/answer?secret=1', 'POST', 200)).toMatchObject({
    route: '/v1/support/answer',
    method: 'POST',
  });
});
