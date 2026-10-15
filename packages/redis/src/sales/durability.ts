import { normalizeIdentifier, normalizePurchase, type PurchaseInput, type PurchaseResponse } from '@flash/contracts';
import { createRedisConnection, assertRedisSafety } from '../index.js';
import { admitPurchase, admissionKeys, type Reservation } from './admission.js';
import { saleKey, assertAdmissionConfiguration, type AdmissionConfiguration } from './configuration.js';
import { confirmationScript, recoveryScript } from './durability-scripts.js';

const durable = Symbol('durable admission');
/** Only a successful durability confirmation can issue this evidence. Never persist this process-local token. */
export type DurableReservation = Reservation & { readonly [durable]: true };
export interface PersistedAdmission { orderId?: string; identifier: string; admittedAtMs: number }
export type Confirmation =
  | { status: 'durable'; reservation: DurableReservation }
  | { status: 'confirming'; diagnostic: 'missing_without_absence_proof' | 'durability_unavailable' };
class CapacityError extends Error {}
type Connection = ReturnType<typeof createRedisConnection>;

/** One operation per socket, bounded concurrency, no waiting queue or automatic replay. */
export class DurableAdmission {
  private active = 0;
  constructor(private readonly url: string, private readonly concurrency = 16, private readonly timeoutMs = 3000,
    private readonly observeBarrier: (seconds: number) => void = () => {},
    private readonly failpoint?: (boundary: string) => Promise<void>) {
    if (failpoint && process.env.NODE_ENV !== 'test') throw new Error('Failpoints require test mode');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid durability limits');
  }
  private async own<T>(operation: (redis: Connection) => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) throw new CapacityError('Durability capacity exhausted');
    const redis = createRedisConnection(this.url, 'durability', this.timeoutMs);
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
          reject(new Error('Durability deadline exceeded'));
        }, this.timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (redis.isOpen) redis.destroy();
      this.active--;
    }
  }
  private async barrier(redis: Connection) {
    const started = performance.now();
    let reply: unknown;
    try { reply = await redis.sendCommand(['WAITAOF', '1', '0', String(this.timeoutMs)]); }
    finally { this.observeBarrier((performance.now() - started) / 1000); }
    if (!Array.isArray(reply) || reply[0] !== 1) throw new Error('Local AOF durability unconfirmed');
  }
  private async confirm(redis: Connection, saleId: string, identifier: string): Promise<Confirmation> {
    const reply = await redis.sendCommand(['EVAL', confirmationScript, '5', ...admissionKeys(saleId), identifier, saleId]);
    if (!Array.isArray(reply)) throw new Error('Invalid confirmation reply');
    if (reply.length === 0) return { status: 'confirming', diagnostic: 'missing_without_absence_proof' };
    const [requestKey, timestamp, streamId] = reply;
    if (typeof requestKey !== 'string' || typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
        !Number.isSafeInteger(Number(timestamp)) || typeof streamId !== 'string' || !/^\d+-\d+$/.test(streamId)) throw new Error('Invalid reservation');
    await this.failpoint?.('before_durability');
    await this.barrier(redis);
    await this.failpoint?.('after_durability');
    return { status: 'durable', reservation: { requestKey, admittedAtMs: Number(timestamp), streamId, [durable]: true } };
  }
  async place(saleId: string, input: PurchaseInput): Promise<PurchaseResponse> {
    const payload = normalizePurchase(saleId, input);
    try {
      return await this.own(async redis => {
        await this.failpoint?.('before_send');
        const result = await admitPurchase(redis, payload.saleId, payload);
        await this.failpoint?.('after_send');
        if (result.status === 'rejected') {
          await this.barrier(redis);
          return { status: 'REJECTED', reason: result.reason };
        }
        const confirmation = await this.confirm(redis, payload.saleId, payload.identifier).catch(() => ({ status: 'confirming' } as const));
        if (confirmation.status !== 'durable') {
          const existingOrder = { status: 'PROCESSING', phase: 'confirming' } as const;
          return result.status === 'already_placed' ? { status: 'REJECTED', reason: 'already_placed', existingOrder } : existingOrder;
        }
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
    catch { return { status: 'confirming', diagnostic: 'durability_unavailable' }; }
  }
  /** Worker must call before its DB transaction; a stream entry alone grants no authority. */
  async confirmForWorker(saleId: string, identifier: string, requestKey: string, streamId: string): Promise<DurableReservation> {
    const result = await this.lookup(saleId, identifier);
    if (result.status !== 'durable' || result.reservation.requestKey !== requestKey || result.reservation.streamId !== streamId) {
      throw new Error('Worker admission durability unconfirmed; retain message and reservation');
    }
    return result.reservation;
  }
  /** Supply the complete DB order snapshot for this sale; mismatch keeps the restart fence closed. */
  async recover(sale: AdmissionConfiguration, orders: PersistedAdmission[]): Promise<void> {
    await this.own(async redis => {
      await redis.hDel(saleKey(sale.id), 'recovered_run');
      await assertAdmissionConfiguration(redis, sale);
      const run = (await redis.info('server')).match(/run_id:([^\r\n]+)/)?.[1];
      if (!run) throw new Error('Missing Redis run ID');
      await redis.sendCommand(['EVAL', recoveryScript, '5', ...admissionKeys(sale.id), run, JSON.stringify(orders), sale.id]);
      await this.barrier(redis);
    });
  }
}
