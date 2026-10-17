/** Structural interface keeps Redis instrumentation independent of the HTTP metrics implementation. */
export interface AdmissionMetrics {
  add(name: string, value?: number): void;
  set(name: string, value: number): void;
  observe(name: string, seconds: number): void;
}

export type AdmissionOperation = 'purchase' | 'lookup' | 'recovery';

// Cumulative histogram buckets: 0.25-ms resolution through 20 ms, then bounded tails.
const bounds = [
  ...Array.from({ length: 80 }, (_, i) => (i + 1) / 4000),
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2,
  3,
  5,
  10,
];

export class PoolMeasurements {
  private active = 0;
  private peak = 0;
  private maxima = new Map<string, number>();
  constructor(private readonly metrics?: AdmissionMetrics) {}
  duration(name: string, seconds: number): void {
    if (!this.metrics) return;

    this.metrics.observe(name, seconds);

    const maximum = Math.max(this.maxima.get(name) ?? 0, seconds);

    this.maxima.set(name, maximum);
    this.metrics.set(`${name}_max`, maximum);

    for (const bound of bounds)
      if (seconds <= bound) this.metrics.add(`${name}_bucket{le="${bound}"}`);

    this.metrics.add(`${name}_bucket{le="+Inf"}`);
  }
  acquire(): void {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.metrics?.set('redis_pool_active', this.active);
    this.metrics?.set('redis_pool_active_peak', this.peak);
  }
  release(): void {
    this.active--;
    this.metrics?.set('redis_pool_active', this.active);
  }
  expired(): void {
    this.metrics?.add('redis_pool_acquire_expired_total');
  }
}
