import { check } from 'k6';
import { consume, commonThresholds } from './helpers.js';

export const options = {
  scenarios: {
    burst: { executor: 'shared-iterations', vus: 50, iterations: 500, maxDuration: '20s' },
  },
  thresholds: commonThresholds,
};

export default function () {
  const response = consume('load:burst', 1, 100, 0.001);
  check(response, { 'allowed or rate limited': (r) => r.status === 200 || r.status === 429 });
}
