import http from 'k6/http';
import { check } from 'k6';
// Foundation smoke only; the one-second sale burst harness belongs to DEV-18.
export const options = { vus: 2, duration: '2s', thresholds: { checks: ['rate==1'] } };
export default function () {
  check(http.get(`${__ENV.BASE_URL}/health/ready`), { ready: (r) => r.status === 200 });
}
