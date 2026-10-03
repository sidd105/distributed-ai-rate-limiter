import { consume, commonThresholds } from './helpers.js';

export const options = {
  scenarios: {
    hot_tenant: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
  },
  thresholds: commonThresholds,
};

export default function () {
  consume('load:one-hot-tenant', 1, 100, 50);
}
