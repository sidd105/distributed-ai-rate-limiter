import { check } from 'k6';
import { consume, commonThresholds } from './helpers.js';

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: commonThresholds,
};

export default function () {
  const response = consume('load:sustained', 1, 20, 10);
  check(response, { 'allowed or rate limited': (r) => r.status === 200 || r.status === 429 });
}
