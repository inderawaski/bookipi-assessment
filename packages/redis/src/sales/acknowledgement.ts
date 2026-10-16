import { normalizeIdentifier, normalizePurchase, type PurchaseInput, type PurchaseResponse } from '@flash/contracts';
import { createRedisConnection, assertRedisSafety } from '../index.js';
import { admitPurchase, admissionKeys, type Reservation } from './admission.js';
import type { AdmissionConfiguration } from './configuration.js';
import { confirmationScript, recoveryScript } from './state-scripts.js';

const validated = Symbol('validated admission');
/** Validates current primary state only; this token is not disk/replica durability evidence. */
export type ValidatedReservation = Reservation & { readonly [validated]: true };
export interface PersistedAdmission { orderId?: string; identifier: string; admittedAtMs: number }
export type Confirmation =
  | { status: 'present'; reservation: ValidatedReservation }
  | { status: 'confirming'; diagnostic: 'missing_without_absence_proof' | 'admission_unavailable' };
class CapacityError extends Error {}
type Connection = ReturnType<typeof createRedisConnection>;

/** One operation per socket, bounded concurrency, no waiting queue or automatic replay. */
export class RedisAdmission {
  private active = 0;
  constructor(private readonly url: string, private readonly concurrency = 16, private readonly timeoutMs = 3000,
    private readonly failpoint?: (boundary: string) => Promise<void>) {
    if (failpoint && process.env.NODE_ENV !== 'test') throw new Error('Failpoints require test mode');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid admission limits');
  }
  private async own<T>(operation: (redis: Connection) => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) throw new CapacityError('Admission capacity exhausted');
    const redis = createRedisConnection(this.url, 'admission', this.timeoutMs);
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { await redis.connect(); await assertRedisSafety(redis);
          const persistence = await redis.info('persistence');
          if (!persistence.includes('aof_enabled:1\r\n') || !persistence.includes('aof_last_write_status:ok\r\n')) throw new Error('AOF persistence unavailable');
          return operation(redis); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          if (redis.isOpen) redis.destroy();
          reject(new Error('Admission deadline exceeded'));
        }, this.timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (redis.isOpen) redis.destroy();
      this.active--;
    }
  }
  private async confirm(redis: Connection, saleId: string, identifier: string): Promise<Confirmation> {
    await this.failpoint?.('before_lookup');
    const reply = await redis.sendCommand(['EVAL', confirmationScript, '5', ...admissionKeys(saleId), identifier, saleId]);
    if (!Array.isArray(reply)) throw new Error('Invalid confirmation reply');
    if (reply.length === 0) return { status: 'confirming', diagnostic: 'missing_without_absence_proof' };
    const [requestKey, timestamp, streamId] = reply;
    if (typeof requestKey !== 'string' || typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
        !Number.isSafeInteger(Number(timestamp)) || typeof streamId !== 'string' || !/^\d+-\d+$/.test(streamId)) throw new Error('Invalid reservation');
    return { status: 'present', reservation: { requestKey, admittedAtMs: Number(timestamp), streamId, [validated]: true } };
  }
  async place(saleId: string, input: PurchaseInput): Promise<PurchaseResponse> {
    const payload = normalizePurchase(saleId, input);
    try {
      return await this.own(async redis => {
        await this.failpoint?.('before_send');
        const result = await admitPurchase(redis, payload.saleId, payload);
        await this.failpoint?.('after_send');
        if (result.status === 'rejected') return { status: 'REJECTED', reason: result.reason };
        await this.failpoint?.('before_acknowledgement');
        const existingOrder = { status: 'PROCESSING', phase: 'queued' } as const;
        return result.status === 'already_placed' ? { status: 'REJECTED', reason: 'already_placed', existingOrder } : existingOrder;
      });
    } catch (error) {
      return error instanceof CapacityError ? { status: 'REJECTED', reason: 'busy' } : { status: 'PROCESSING', phase: 'confirming' };
    }
  }
  async lookup(saleId: string, identifier: string): Promise<Confirmation> {
    const sale = normalizeIdentifier(saleId), person = normalizeIdentifier(identifier);
    try { return await this.own(redis => this.confirm(redis, sale, person)); }
    catch { return { status: 'confirming', diagnostic: 'admission_unavailable' }; }
  }
  /** Validate mappings before the DB transaction; no persistence/replication wait. */
  async confirmForWorker(saleId: string, identifier: string, requestKey: string, streamId: string): Promise<ValidatedReservation> {
    const result = await this.lookup(saleId, identifier);
    if (result.status !== 'present' || result.reservation.requestKey !== requestKey || result.reservation.streamId !== streamId) {
      throw new Error('Worker admission validation unconfirmed; retain message and reservation');
    }
    return result.reservation;
  }
  /** Supply the complete DB order snapshot for this sale; mismatch keeps the restart fence closed. */
  async recover(sale: AdmissionConfiguration, orders: PersistedAdmission[]): Promise<void> {
    await this.own(async redis => {
      const run = (await redis.info('server')).match(/run_id:([^\r\n]+)/)?.[1];
      if (!run) throw new Error('Missing Redis run ID');
      await this.failpoint?.('before_recovery');
      // Fencing, configuration validation and reopening are one atomic operation.
      // A peer cannot observe a valid epoch temporarily removed by this recovery.
      await redis.sendCommand(['EVAL', recoveryScript, '5', ...admissionKeys(sale.id), run, JSON.stringify(orders), sale.id,
        String(Date.parse(sale.startsAt)), String(Date.parse(sale.endsAt)), String(sale.initialStock)]);
    });
  }
}
