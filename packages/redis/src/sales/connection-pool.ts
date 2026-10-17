import { performance } from 'node:perf_hooks';
import {
  PoolMeasurements,
  type AdmissionMetrics,
  type AdmissionOperation,
} from './pool-metrics.js';
import { setMaxListeners } from 'node:events';
import { createClientPool, TimeoutError } from 'redis';

type Pool = ReturnType<typeof createClientPool>;
type Connection = Parameters<Parameters<Pool['execute']>[0]>[0];
export class CapacityError extends Error {}

/** Library-managed acquisition, with application operation deadlines and shutdown. */
export class AdmissionConnections {
  private pool?: Pool;
  private connecting?: Promise<unknown>;
  private readonly shutdown = new AbortController();
  private readonly measurements: PoolMeasurements;
  constructor(
    private readonly url: string,
    private readonly limit: number | undefined,
    private readonly timeoutMs: number,
    metrics?: AdmissionMetrics,
  ) {
    this.measurements = new PoolMeasurements(metrics);
    // Concurrent callers share shutdown notification; this does not limit concurrency.
    setMaxListeners(0, this.shutdown.signal);
  }
  async connect(): Promise<void> {
    if (this.shutdown.signal.aborted)
      throw new Error('Admission connections closed');
    if (!this.pool) {
      this.pool = createClientPool(
        {
          url: this.url,
          name: 'admission',
          disableOfflineQueue: true,
          commandsQueueMaxLength: 256,
          socket: { connectTimeout: this.timeoutMs, reconnectStrategy: false },
        },
        // Explicit sizes are only used by deterministic test fixtures. Services omit all pool options.
        ...(this.limit === undefined
          ? []
          : [{ minimum: 1, maximum: this.limit }]),
      );
      this.pool.on('error', () => {
        /* Operation/readiness callers handle failures. */
      });
      this.connecting = this.pool.connect();
    }
    const connecting = this.connecting;
    try {
      await connecting;
    } catch (error) {
      if (this.connecting === connecting) {
        this.pool = undefined;
        this.connecting = undefined;
      }
      throw error;
    }
    if (this.shutdown.signal.aborted) {
      this.pool?.destroy();
      throw new Error('Admission connections closed');
    }
  }
  async own<T>(
    operation: (redis: Connection) => Promise<T>,
    kind: AdmissionOperation,
  ): Promise<T> {
    await this.connect();
    let acquired = false;
    const waitStarted = performance.now();
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error('Admission connections closed'));
      this.shutdown.signal.addEventListener('abort', stop, { once: true });
      if (this.shutdown.signal.aborted) stop();
    });
    try {
      return await Promise.race([
        this.pool!.execute(async (redis) => {
          acquired = true;
          const leasedAt = performance.now();
          this.measurements.duration(
            `redis_${kind}_acquire_seconds`,
            (leasedAt - waitStarted) / 1000,
          );
          if (this.shutdown.signal.aborted)
            throw new Error('Admission connections closed');
          this.measurements.acquire();
          let expired = false;
          const cancellation = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              (async () => {
                // A destroyed lease stays owned by the library; reconnect only before a new operation.
                if (!redis.isReady) await redis.connect();
                if (expired || this.shutdown.signal.aborted) {
                  redis.destroy();
                  throw new Error('Admission connections unavailable');
                }
                return operation(redis.withAbortSignal(cancellation.signal));
              })(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  expired = true;
                  cancellation.abort();
                  redis.destroy();
                  reject(new Error('Admission deadline exceeded'));
                }, this.timeoutMs);
              }),
            ]);
          } catch (error) {
            cancellation.abort();
            redis.destroy();
            throw error;
          } finally {
            clearTimeout(timer);
            cancellation.abort();
            this.measurements.duration(
              `redis_${kind}_lease_seconds`,
              (performance.now() - leasedAt) / 1000,
            );
            this.measurements.release();
          }
        }),
        stopped,
      ]);
    } catch (error) {
      if (!acquired && error instanceof TimeoutError) {
        this.measurements.expired();
        this.measurements.duration(
          `redis_${kind}_acquire_expired_seconds`,
          (performance.now() - waitStarted) / 1000,
        );
        throw new CapacityError('Admission connection acquisition timed out', {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.shutdown.signal.removeEventListener('abort', stop);
    }
  }
  close(): void {
    this.shutdown.abort();
    this.pool?.destroy();
  }
}
