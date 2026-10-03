import exec from 'k6/execution';
import { consume, commonThresholds } from './helpers.js';

export const options = {
  scenarios: {
    many_tenants: {
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
  // The demo auth maps to one real tenant; these 100 logical keys model the low-contention shape.
  consume(`load:tenant:${exec.scenario.iterationInTest % 100}`, 1, 100, 50);
}
