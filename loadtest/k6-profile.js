// k6 arrival-rate (open-model) scenarios for the provisional profile in docs/build/CAPACITY_REPORT.md.
// NOT YET RUN: k6 is not installed in the authoring environment. Run: k6 run -e BASE=https://staging... -e TOKENS=tokens.json loadtest/k6-profile.js
import http from 'k6/http';
import { check } from 'k6';
const BASE = __ENV.BASE || 'http://127.0.0.1:4001';
export const options = {
  scenarios: {
    sustained: { executor: 'constant-arrival-rate', rate: 500, timeUnit: '1s', duration: '30m', preAllocatedVUs: 300, maxVUs: 2000 },
    // burst: { executor: 'constant-arrival-rate', rate: 2000, timeUnit: '1s', duration: '10m', preAllocatedVUs: 1000, maxVUs: 5000, startTime: '31m' },
    // soak:  { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '4h', preAllocatedVUs: 200, maxVUs: 1000, startTime: '45m' },
  },
  thresholds: { http_req_failed: ['rate<0.001'], 'http_req_duration{kind:read}': ['p(95)<300'], dropped_iterations: ['count==0'] },
};
export default function () {
  const r = http.get(`${BASE}/v1/products?limit=20`, { tags: { kind: 'read' } });
  check(r, { ok: (x) => x.status === 200 });
}
