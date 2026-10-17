import { expect, it } from 'vitest';
import { PoolMeasurements } from './pool-metrics.js';

it('records cumulative duration buckets, maxima, active peak and acquisition expiry', () => {
  const values = new Map<string, number>();
  const metrics = {
    add(name: string, value = 1) {
      values.set(name, (values.get(name) ?? 0) + value);
    },
    set(name: string, value: number) {
      values.set(name, value);
    },
    observe(name: string, value: number) {
      this.add(`${name}_count`);
      this.add(`${name}_sum`, value);
    },
  };
  const measurement = new PoolMeasurements(metrics);

  measurement.duration('lease', 0.001);
  measurement.duration('lease', 0.003);
  measurement.acquire();
  measurement.acquire();
  measurement.release();
  measurement.expired();
  measurement.release();
  expect(values.get('lease_count')).toBe(2);
  expect(values.get('lease_sum')).toBe(0.004);
  expect(values.get('lease_max')).toBe(0.003);
  expect(values.get('lease_bucket{le="0.001"}')).toBe(1);
  expect(values.get('lease_bucket{le="0.003"}')).toBe(2);
  expect(values.get('lease_bucket{le="+Inf"}')).toBe(2);
  expect(values.get('redis_pool_active')).toBe(0);
  expect(values.get('redis_pool_active_peak')).toBe(2);
  expect(values.get('redis_pool_acquire_expired_total')).toBe(1);
});
