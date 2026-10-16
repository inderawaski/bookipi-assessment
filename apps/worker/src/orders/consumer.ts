import { correlation, type Metrics } from '@flash/operations';
import { randomUUID } from 'node:crypto';
import { persistOrder, OrderConflictError, OrderCapacityError, type createDatabase } from '@flash/database';
import { admissionKeys, createRedisConnection, RedisAdmission, saleKey, finishAttempt, claimAttempt, delayAttempt, defaultRetryPolicy, type RetryPolicy } from '@flash/redis';

export const orderGroup = 'orders';
// Far above the 3s admission deadline and bounded DB statements. Correctness still relies
// on PostgreSQL uniqueness if a paused original resumes after reclamation.
export const reclaimIdleMs = 60000;
type Connection = ReturnType<typeof createRedisConnection>;
export interface StreamOrder { id: string; message: Record<string, string> }

export async function processOrder(database: ReturnType<typeof createDatabase>, redis: Connection,
  admission: RedisAdmission, saleId: string, entry: StreamOrder, failpoint?: (boundary: string) => Promise<void>) {
  if (failpoint && process.env.NODE_ENV !== 'test') throw new Error('Failpoints require test mode');
  await failpoint?.('receipt');
  const fields = entry.message;
  const quarantine = `${saleKey(saleId)}:quarantine`;
  if (await redis.hExists(quarantine, entry.id)) return;
  try {
    if (fields.sale_id !== saleId || !fields.identifier || !fields.request_key ||
      !/^\d+$/.test(fields.admitted_at_ms ?? '') || !Number.isSafeInteger(Number(fields.admitted_at_ms))) {
      throw new OrderConflictError('Invalid stream identity metadata');
    }
    const confirmation = await admission.lookup(saleId, fields.identifier);
    if (confirmation.status !== 'present') throw new Error('Admission validation unavailable');
    await failpoint?.('after_validation');
    const reservation = confirmation.reservation;
    if (reservation.requestKey !== fields.request_key || reservation.streamId !== entry.id) {
      throw new OrderConflictError('Conflicting admission identity');
    }
    if (reservation.admittedAtMs !== Number(fields.admitted_at_ms)) throw new OrderConflictError('Conflicting admission timestamp');
    const orderId = await persistOrder(database, { saleId, identifier: fields.identifier, admittedAtMs: reservation.admittedAtMs }, failpoint);
    // Both operations may repeat after a crash; neither removes the stream entry.
    await failpoint?.('before_status');
    await redis.hSet(`${saleKey(saleId)}:completed`, fields.identifier, orderId);
    await failpoint?.('after_status');
    await redis.xAck(admissionKeys(saleId)[4], orderGroup, entry.id);
    await failpoint?.('after_ack');
    return orderId;
  } catch (error) {
    if (!(error instanceof OrderConflictError)) throw error;
    if (error instanceof OrderCapacityError) {
      // Do not admit more buyers against Redis stock that disagrees with committed orders.
      await redis.hSet(saleKey(saleId), 'admission_fault', 'committed_order_capacity');
    }
    // Retain pending work and its raw stream data for operator investigation.
    await redis.hSet(quarantine, entry.id, error.message);
  }
}

export async function createOrderConsumer(url: string, database: ReturnType<typeof createDatabase>,
  admission: RedisAdmission, sales: () => Promise<string[]>, report: (error: unknown) => void, policy: RetryPolicy = defaultRetryPolicy, metrics?: Metrics) {
  const blocking = createRedisConnection(url, 'blocking-consumer');
  const commands = createRedisConnection(url, 'commands');
  try { await Promise.all([blocking.connect(), commands.connect()]); }
  catch (error) {
    if (blocking.isOpen) blocking.destroy();
    if (commands.isOpen) commands.destroy();
    throw error;
  }
  let stopped = false;
  const consumer = randomUUID();
  const cursors = new Map<string, string>();
  const handle = async (saleId: string, entry: StreamOrder) => {
    if (await commands.hExists(`${saleKey(saleId)}:quarantine`, entry.id)) {
      await commands.zRem(`${saleKey(saleId)}:retry_due`, entry.id);
      return;
    }
    const attempt = await claimAttempt(commands, saleId, entry.id, policy);
    if (!attempt) return;
    metrics?.add('worker_attempts_total');
    try {
      const orderId = await processOrder(database, commands, admission, saleId, entry);
      if (await commands.hExists(`${saleKey(saleId)}:quarantine`, entry.id)) {
        await commands.zRem(`${saleKey(saleId)}:retry_due`, entry.id);
      } else {
        await finishAttempt(commands, saleId, entry.id, attempt);
        if (orderId) metrics?.add('database_completion_total');
        console.info({ orderId, requestKeyHash: correlation(entry.message.request_key ?? ''), reservationHash: correlation(saleId + ':' + entry.message.identifier) }, 'Order completed');
      }
    }
    catch {
      metrics?.add('worker_retries_total');
      await delayAttempt(commands, saleId, entry.id, attempt, policy);
      report(new Error('Order delayed; allocation retained'));
    }
  };
  const run = (async () => {
    while (!stopped) {
      try {
        if (!commands.isReady) await commands.connect();
        if (!blocking.isReady) await blocking.connect();
        const ids = await sales();
        if (!ids.length) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        for (const saleId of ids) {
          const stream = admissionKeys(saleId)[4];
          try { await commands.xGroupCreate(stream, orderGroup, '0', { MKSTREAM: true }); }
          catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error; }
          const claimed = await commands.xAutoClaim(stream, orderGroup, consumer, reclaimIdleMs, cursors.get(saleId) ?? '0-0', { COUNT: 10 });
          cursors.set(saleId, claimed.nextId);
          for (const entry of claimed.messages) if (entry) await handle(saleId, entry);
          const clock = await commands.sendCommand(['TIME']) as string[];
          const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
          const due = await commands.zRangeByScore(`${saleKey(saleId)}:retry_due`, 0, now, { LIMIT: { offset: 0, count: 10 } });
          for (const id of due) {
            const entries = await commands.xRange(stream, id, id);
            if (entries?.[0]) await handle(saleId, entries[0]);
            const raw = await commands.hGet(`${saleKey(saleId)}:retries`, id);
            if (raw && JSON.parse(raw).exhausted) await commands.zRem(`${saleKey(saleId)}:retry_due`, id);
          }
          const batches = await blocking.xReadGroup(orderGroup, consumer, { key: stream, id: '>' }, { COUNT: 10, BLOCK: 250 });
          for (const batch of batches ?? []) for (const entry of batch.messages) await handle(saleId, entry);
        }
      } catch (error) {
        if (!stopped) { report(error); await new Promise(resolve => setTimeout(resolve, 1000 + Math.floor(Math.random() * 1000))); }
      }
    }
  })();
  return async () => {
    stopped = true;
    if (blocking.isOpen) blocking.destroy();
    await run;
    if (commands.isOpen) commands.destroy();
  };
}
