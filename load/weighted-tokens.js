import exec from 'k6/execution';
import { consume, commonThresholds } from './helpers.js';

export const options = {
  scenarios: {
    weighted_tokens: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
  },
  thresholds: commonThresholds,
};

const costs = [100, 500, 1200];

export default function () {
  consume(
    'load:weighted-tokens',
    costs[exec.scenario.iterationInTest % costs.length],
    50_000,
    5_000,
    'tokens',
  );
}
